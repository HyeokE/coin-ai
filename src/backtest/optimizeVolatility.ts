import { getSymbolRiskPolicy, GLOBAL_CONFIG, OPTIMIZATION_CONFIG } from '../config/config';
import { MarketDataService } from '../market/MarketDataService';
import { VolatilityThresholds } from '../trading/TradingCore';
import { Candle } from '../types';
import {
  BacktestConfig,
  BacktestSimulator,
  BacktestTrade,
  DebugStats,
  DecisionProvider,
  ExitProvider,
} from './BacktestSimulator';
import { emaSeries, rsiSeries, ribbonMinSeries } from '../indicators';
import { knnBuySeries } from '../ml';
import { createVideoStrategyProvider, createVideoExitProvider } from './strategies/videoStrategy';

type ExitReason = BacktestTrade['exitReason'];
type ExitReasonCounts = Record<ExitReason, number>;

// --- Decision reason tracking helpers ---
type DecisionReasonCounts = Map<string, number>;

type TopReason = { reason: string; count: number };

function bumpReason(map: DecisionReasonCounts, reason: string): void {
  const key = (reason || 'Unknown').trim() || 'Unknown';
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topReasons(map: DecisionReasonCounts, limit = 8): TopReason[] {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function formatTopReasons(items: TopReason[]): string {
  if (!items.length) return '(none)';
  return items.map((x) => `${x.reason}=${x.count}`).join(', ');
}

function createEmptyExitReasonCounts(): ExitReasonCounts {
  return { STOP_LOSS: 0, TAKE_PROFIT: 0, SIGNAL: 0, END: 0 };
}

function calcExitReasonCounts(trades: BacktestTrade[]): ExitReasonCounts {
  const counts = createEmptyExitReasonCounts();
  for (const t of trades) counts[t.exitReason]++;
  return counts;
}

function formatExitReasonCounts(c: ExitReasonCounts): string {
  return `TP=${c.TAKE_PROFIT}, SL=${c.STOP_LOSS}, END=${c.END}, SIGNAL=${c.SIGNAL}`;
}

function wrapDecisionProviderForOptimization(
  base: DecisionProvider,
  opts: {
    gateOnSignal: boolean;
    allowedTypes: Set<string> | null;
    reasonCounts?: DecisionReasonCounts;
  },
): DecisionProvider {
  return (candlesWindow, signal, position) => {
    const s = signal && typeof signal === 'object' && 'type' in signal ? signal : null;

    const filteredSignal = !s || !opts.allowedTypes ? s : opts.allowedTypes.has(s.type) ? s : null;

    // For optimization runs, we often want thresholds to matter.
    // If gating is enabled and there's no (allowed) signal, skip the entry check entirely.
    if (opts.gateOnSignal && !filteredSignal) {
      if (opts.reasonCounts) bumpReason(opts.reasonCounts, 'No volatility signal');
      return { shouldTrade: false, confidence: 0, reasoning: 'No volatility signal' };
    }

    const out = base(candlesWindow, filteredSignal, position);
    if (!out.shouldTrade && opts.reasonCounts)
      bumpReason(opts.reasonCounts, out.reasoning || 'No trade');
    return out;
  };
}

interface OptimizationResult {
  atrMultiplier: number;
  priceSurgePct: number;
  volumeSpikeMultiplier: number;
  totalPnl: number;
  totalPnlPercent: number;
  trades: number;
  winRate: number;
  maxDrawdown: number;
  sharpeRatio: number;
  signalsDetected: number;
  debugStats: DebugStats;
  exitReasons: ExitReasonCounts;
  decisionTopReasons: TopReason[];
}

async function fetchMinuteCandles(symbol: string, count: number): Promise<Candle[]> {
  console.log(`   Fetching ${count.toLocaleString()} candles...`);
  const t0 = Date.now();

  const marketService = MarketDataService.createSimple(symbol);
  const candles = await marketService.fetchCandlesPaginated(
    symbol,
    'minutes',
    count,
    GLOBAL_CONFIG.candleMinutes,
    (loaded, total) => {
      if (loaded % 2000 === 0) {
        const progress = ((loaded / total) * 100).toFixed(1);
        process.stdout.write(
          `   Progress: ${loaded.toLocaleString()}/${total.toLocaleString()} (${progress}%)\r`,
        );
      }
    },
  );

  const t1 = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n   Loaded ${candles.length.toLocaleString()} candles`);
  console.log(`   Candle fetch time: ${t1}s`);
  return candles;
}

function generateParamCombinations(): VolatilityThresholds[] {
  const { atrMults, surgePcts, volSpikes } = OPTIMIZATION_CONFIG;

  const combos: VolatilityThresholds[] = [];
  for (const a of atrMults) {
    for (const p of surgePcts) {
      for (const v of volSpikes) {
        combos.push({ atrMultiplier: a, priceSurgePct: p, volumeSpikeMultiplier: v });
      }
    }
  }
  return combos;
}

function splitIntoFolds(len: number, foldCount: number): Array<{ start: number; end: number }> {
  const foldSize = Math.floor(len / foldCount);
  const folds: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < foldCount; i++) {
    const start = i * foldSize;
    const end = i === foldCount - 1 ? len : (i + 1) * foldSize;
    folds.push({ start, end });
  }
  return folds;
}

function compositeScore(r: OptimizationResult): number {
  if (r.trades < 2) return -5;

  const pnl = Math.max(Math.min(r.totalPnlPercent, 10), -10) / 10;
  const dd = Math.min(r.maxDrawdown, 10) / 10;
  const tradesBonus = Math.min(r.trades, 20) / 20;

  return pnl * 0.7 - dd * 0.2 + tradesBonus * 0.1;
}

interface StrategyParams {
  rsiLower: number;
  swingLookback: number;
  rr: number;
  stopBufferPct: number;
  beTriggerR: number;
  useEma200Filter: boolean;
  useRibbonEma200Filter: boolean;
  dipLookback: number;
  useDipReclaim: boolean;
  useKnn: boolean;
}

interface FullOptimizationResult extends OptimizationResult {
  strategy: StrategyParams;
}

function getFixedStrategy(): StrategyParams {
  return { ...OPTIMIZATION_CONFIG.fixedStrategy };
}

function generateStrategyCombinations(): StrategyParams[] {
  const optMode = OPTIMIZATION_CONFIG.mode;
  console.log(`   [generateStrategyCombinations] OPT_MODE="${optMode}"`);

  if (optMode === 'VOL_ONLY') {
    console.log(`   [generateStrategyCombinations] VOL_ONLY mode -> returning fixed strategy`);
    return [getFixedStrategy()];
  }

  const { strategyGrid } = OPTIMIZATION_CONFIG;
  const {
    rsiLowers,
    swingLookbacks,
    rrs,
    stopBuffers,
    beTriggers,
    dipLookbacks,
    comboCap: cap,
  } = strategyGrid;

  const combos: StrategyParams[] = [];
  const useEma200Filters = [true, false];
  const useRibbonEma200Filters = [true, false];

  for (const useEma200Filter of useEma200Filters) {
    for (const useRibbonEma200Filter of useRibbonEma200Filters) {
      for (const dipLookback of dipLookbacks) {
        for (const rsiLower of rsiLowers) {
          for (const swingLookback of swingLookbacks) {
            for (const rr of rrs) {
              for (const stopBufferPct of stopBuffers) {
                for (const beTriggerR of beTriggers) {
                  for (const useDipReclaim of [true, false]) {
                    for (const useKnn of [true, false]) {
                      combos.push({
                        rsiLower,
                        swingLookback,
                        rr,
                        stopBufferPct,
                        beTriggerR,
                        useEma200Filter,
                        useRibbonEma200Filter,
                        dipLookback,
                        useDipReclaim,
                        useKnn,
                      });
                      if (combos.length >= cap) return combos;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return combos;
}

function runBacktestWithParams(args: {
  symbol: string;
  candles: Candle[];
  thresholds: VolatilityThresholds;
  strategy: StrategyParams;
  decisionProvider: DecisionProvider;
  exitProvider?: ExitProvider;
  fold?: { start: number; end: number };
}): FullOptimizationResult {
  const { symbol, candles, thresholds, strategy, decisionProvider, exitProvider, fold } = args;

  const feeRate = GLOBAL_CONFIG.feeRate;

  const config: BacktestConfig = {
    symbol,
    initialCapitalKrw: 1_000_000,
    riskPolicy: getSymbolRiskPolicy(symbol),
    volatilityThresholds: thresholds,
    feeRate,
    beTriggerR: strategy.beTriggerR,
  };

  const sim = new BacktestSimulator(config);

  const start = fold ? fold.start : 0;
  const end = fold ? fold.end : candles.length;

  const gateOnSignal = OPTIMIZATION_CONFIG.gateOnSignal;
  const allowedTypes = OPTIMIZATION_CONFIG.signalTypes
    ? new Set(OPTIMIZATION_CONFIG.signalTypes)
    : null;
  const reasonCounts: DecisionReasonCounts = new Map();
  const wrapped = wrapDecisionProviderForOptimization(decisionProvider, {
    gateOnSignal,
    allowedTypes,
    reasonCounts,
  });

  const result = sim.runRange(candles, start, end, wrapped, exitProvider);

  return {
    atrMultiplier: thresholds.atrMultiplier,
    priceSurgePct: thresholds.priceSurgePct,
    volumeSpikeMultiplier: thresholds.volumeSpikeMultiplier,
    strategy,
    totalPnl: result.totalPnl,
    totalPnlPercent: result.totalPnlPercent,
    trades: result.totalTrades,
    winRate: result.winRate,
    maxDrawdown: result.maxDrawdown,
    sharpeRatio: result.sharpeRatio,
    signalsDetected: result.signalsDetected,
    debugStats: result.debugStats,
    exitReasons: calcExitReasonCounts(result.trades),
    decisionTopReasons: topReasons(reasonCounts, 8),
  };
}

async function optimizeSymbol(symbol: string): Promise<void> {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📊 Optimizing ${symbol}`);
  console.log(`${'═'.repeat(60)}`);

  const candleCount = parseInt(process.env.CANDLE_COUNT || '100000', 10);
  const candles = await fetchMinuteCandles(symbol, candleCount);

  const closes = candles.map((c) => c.close);
  const lows = candles.map((c) => c.low);

  const firstDate = new Date(candles[0].timestamp);
  const lastDate = new Date(candles[candles.length - 1].timestamp);
  const daysDiff = Math.floor((lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24));

  const minPrice = Math.min(...closes);
  const maxPrice = Math.max(...closes);
  const volatility = ((maxPrice - minPrice) / minPrice) * 100;

  const feeRate = GLOBAL_CONFIG.feeRate;
  console.log(
    `   Period: ${firstDate.toLocaleDateString()} ~ ${lastDate.toLocaleDateString()} (${daysDiff} days)`,
  );
  console.log(`   Price Range: ${minPrice.toLocaleString()} ~ ${maxPrice.toLocaleString()}`);
  console.log(`   Volatility: ${volatility.toFixed(2)}%`);
  console.log(
    `   Fee: ${(feeRate * 100).toFixed(3)}% per side (~${(feeRate * 2 * 100).toFixed(2)}% round-trip)`,
  );
  {
    const { gateOnSignal, signalTypes } = OPTIMIZATION_CONFIG;
    console.log(
      `   Opt gateOnSignal: ${gateOnSignal ? 'ON' : 'OFF'}${signalTypes ? `, allowedTypes=[${signalTypes.join(',')}]` : ''}`,
    );
  }

  console.log(`\n🧮 Precomputing indicators (EMA/Ribbon/RSI/KNN-TradingView)...`);
  const t0 = Date.now();

  const labelThreshold = feeRate * 2;

  const ema200 = emaSeries(closes, 200);
  const ribbonPeriods = [20, 25, 30, 35, 40, 45, 50, 60];
  const ribbon = ribbonPeriods.map((p) => emaSeries(closes, p));
  const ribbonMin = ribbonMinSeries(ribbon, closes);

  const rsi = rsiSeries(closes, 14);

  const knnBuy = knnBuySeries({
    candles,
    closes,
    ema200,
    ribbonMin,
    shortWindow: 14,
    longWindow: 28,
    baseK: 252,
    trainWindow: 600,
    labelThreshold,
    volatilityFilter: true,
    labelHorizon: 30,
    stopBufferPct: 0.002,
    rr: 1.5,
    swingLookback: 8,
  });

  const idxMap = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) {
    idxMap.set(candles[i].timestamp, i);
  }

  const precomputeTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`   Precompute time: ${precomputeTime}s`);

  const optMode = OPTIMIZATION_CONFIG.mode;
  const thresholdCombos = generateParamCombinations();
  const strategyCombos = generateStrategyCombinations();

  console.log(`   Opt mode: ${optMode}`);
  console.log(`   Threshold combos: ${thresholdCombos.length}`);
  console.log(`   Strategy combos: ${strategyCombos.length}`);

  if (optMode === 'VOL_ONLY') {
    const s = strategyCombos[0];
    console.log(
      `   Fixed strategy: rsiL=${s.rsiLower}, swing=${s.swingLookback}, rr=${s.rr}, stopB=${(s.stopBufferPct * 100).toFixed(2)}%, beTrig=${s.beTriggerR}`,
    );
  }

  type Candidate = {
    thresholds: VolatilityThresholds;
    strategy: StrategyParams;
    avgScore: number;
    consistency: number;
  };

  const foldCount = 3;
  const folds = splitIntoFolds(candles.length, foldCount);

  const totalCombos = thresholdCombos.length * strategyCombos.length;
  console.log(`\n⚡ Phase 1: ${foldCount}-Fold Cross Validation`);
  console.log(`   Testing ${totalCombos} combinations × ${foldCount} folds...`);

  const phase1Start = Date.now();
  const candidates: Candidate[] = [];
  let progress = 0;

  for (const thresholds of thresholdCombos) {
    for (const strategy of strategyCombos) {
      const pre = {
        candles,
        closes,
        lows,
        ema200,
        ribbon,
        ribbonMin,
        rsi,
        knnBuy,
        feeRate,
        rsiLower: strategy.rsiLower,
        rsiUpper: 60,
        swingLookback: strategy.swingLookback,
        rr: strategy.rr,
        stopBufferPct: strategy.stopBufferPct,
        idxMap,
        useEma200Filter: strategy.useEma200Filter,
        useRibbonEma200Filter: strategy.useRibbonEma200Filter,
        dipLookback: strategy.dipLookback,
        useDipReclaim: strategy.useDipReclaim,
        useKnn: strategy.useKnn,
      };

      const decisionProvider = createVideoStrategyProvider(pre);
      const exitProvider = OPTIMIZATION_CONFIG.useSignalExit
        ? createVideoExitProvider(pre)
        : undefined;

      const scores: number[] = [];
      for (const fold of folds) {
        const r = runBacktestWithParams({
          symbol,
          candles,
          thresholds,
          strategy,
          decisionProvider,
          exitProvider,
          fold,
        });
        scores.push(compositeScore(r));
      }

      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const variance = scores.reduce((s, x) => s + (x - avg) ** 2, 0) / scores.length;
      const std = Math.sqrt(variance);
      const consistency = Math.abs(avg) > 0.001 ? 1 - Math.min(std / Math.abs(avg), 1) : 0.5;

      candidates.push({ thresholds, strategy, avgScore: avg, consistency });
      progress++;

      if (progress % 50 === 0 || progress === totalCombos) {
        const elapsed = ((Date.now() - phase1Start) / 1000).toFixed(1);
        process.stdout.write(`   Progress: ${progress}/${totalCombos} (${elapsed}s)\r`);
      }
    }
  }

  const phase1Time = ((Date.now() - phase1Start) / 1000).toFixed(1);
  console.log(`\n   Phase 1 completed in ${phase1Time}s`);

  candidates.sort((a, b) => {
    const scoreA = a.avgScore * 0.8 + a.consistency * 0.2;
    const scoreB = b.avgScore * 0.8 + b.consistency * 0.2;
    return scoreB - scoreA;
  });

  console.log(
    '   Top5:',
    candidates.slice(0, 5).map((c) => ({
      t: c.thresholds,
      s: c.strategy,
      avg: c.avgScore.toFixed(4),
      cons: c.consistency.toFixed(3),
    })),
  );

  const topCandidates = candidates.slice(0, 50);
  console.log(`   Passing top ${topCandidates.length} candidates to Phase 2`);

  console.log(
    `\n🔬 Phase 2: Full validation with 100% data (${candles.length.toLocaleString()} candles)`,
  );
  console.log(`   Testing top ${topCandidates.length} candidates...`);

  const phase2Start = Date.now();
  const results: FullOptimizationResult[] = [];

  for (let i = 0; i < topCandidates.length; i++) {
    const { thresholds, strategy } = topCandidates[i];

    const pre = {
      candles,
      closes,
      lows,
      ema200,
      ribbon,
      ribbonMin,
      rsi,
      knnBuy,
      feeRate,
      rsiLower: strategy.rsiLower,
      rsiUpper: 60,
      swingLookback: strategy.swingLookback,
      rr: strategy.rr,
      stopBufferPct: strategy.stopBufferPct,
      idxMap,
      useEma200Filter: strategy.useEma200Filter,
      useRibbonEma200Filter: strategy.useRibbonEma200Filter,
      dipLookback: strategy.dipLookback,
      useDipReclaim: strategy.useDipReclaim,
      useKnn: strategy.useKnn,
    };

    const decisionProvider = createVideoStrategyProvider(pre);
    const exitProvider = OPTIMIZATION_CONFIG.useSignalExit
      ? createVideoExitProvider(pre)
      : undefined;

    results.push(
      runBacktestWithParams({
        symbol,
        candles,
        thresholds,
        strategy,
        decisionProvider,
        exitProvider,
      }),
    );

    const elapsed = ((Date.now() - phase2Start) / 1000).toFixed(1);
    process.stdout.write(`   Progress: ${i + 1}/${topCandidates.length} (${elapsed}s)\r`);
  }

  const phase2Time = ((Date.now() - phase2Start) / 1000).toFixed(1);
  console.log(`\n   Phase 2 completed in ${phase2Time}s`);

  results.sort((a, b) => b.totalPnlPercent - a.totalPnlPercent);

  console.log(`\n📈 Top 10 Configurations (by NET PnL %):`);
  console.log(`${'─'.repeat(140)}`);
  console.log(
    '| Rank | ATR  | Surge  | Vol  | rsiL | swing | rr  | stopB | beTrig | Trades | Win%  | DD%   | PnL%     |',
  );
  console.log(`${'─'.repeat(140)}`);

  for (let i = 0; i < Math.min(10, results.length); i++) {
    const r = results[i];
    const s = r.strategy;
    console.log(
      `| ${String(i + 1).padStart(4)} | ` +
        `${r.atrMultiplier.toFixed(1).padStart(4)} | ` +
        `${(r.priceSurgePct * 100).toFixed(2).padStart(5)}% | ` +
        `${r.volumeSpikeMultiplier.toFixed(1).padStart(4)} | ` +
        `${String(s.rsiLower).padStart(4)} | ` +
        `${String(s.swingLookback).padStart(5)} | ` +
        `${s.rr.toFixed(1).padStart(3)} | ` +
        `${(s.stopBufferPct * 100).toFixed(2).padStart(5)}% | ` +
        `${s.beTriggerR.toFixed(2).padStart(6)} | ` +
        `${String(r.trades).padStart(6)} | ` +
        `${r.winRate.toFixed(1).padStart(5)} | ` +
        `${r.maxDrawdown.toFixed(2).padStart(5)} | ` +
        `${r.totalPnlPercent >= 0 ? '+' : ''}${r.totalPnlPercent.toFixed(2).padStart(7)}% |`,
    );
  }

  console.log(`${'─'.repeat(140)}`);

  const diagCount = Math.min(3, results.length);
  console.log(`\n🔎 Phase 2 Diagnostics (Top ${diagCount}):`);
  for (let i = 0; i < diagCount; i++) {
    const r = results[i];
    const d = r.debugStats;
    const s = r.strategy;
    console.log(
      `   #${i + 1} ATR=${r.atrMultiplier}, Surge=${(r.priceSurgePct * 100).toFixed(2)}%, Vol=${r.volumeSpikeMultiplier}`,
    );
    console.log(
      `       rsiL=${s.rsiLower}, swing=${s.swingLookback}, rr=${s.rr}, stopB=${s.stopBufferPct}, beTrig=${s.beTriggerR}`,
    );
    console.log(
      `       debug: noSignal=${d.noSignal}, agentSkip=${d.agentSkip}, plannerReject=${d.plannerReject}, executed=${d.executed}`,
    );
    console.log(`       exits: ${formatExitReasonCounts(r.exitReasons)}`);
    console.log(`       topDecisionReasons: ${formatTopReasons(r.decisionTopReasons)}`);
  }

  const viable = results.filter((r) => r.trades >= 5 && r.totalPnlPercent > 0);

  if (viable.length) {
    const best = viable[0];
    const s = best.strategy;
    console.log(`\n🎯 Recommended Configuration (NET PnL % 기준):`);
    console.log(`   ATR Multiplier:        ${best.atrMultiplier}`);
    console.log(`   Price Surge Percent:   ${(best.priceSurgePct * 100).toFixed(2)}%`);
    console.log(`   Volume Spike:          ${best.volumeSpikeMultiplier}`);
    console.log(`   RSI Lower:             ${s.rsiLower}`);
    console.log(`   Swing Lookback:        ${s.swingLookback}`);
    console.log(`   Risk:Reward:           ${s.rr}`);
    console.log(`   Stop Buffer:           ${(s.stopBufferPct * 100).toFixed(3)}%`);
    console.log(`   BE Trigger R:          ${s.beTriggerR}`);
    console.log(`   Trades:                ${best.trades}`);
    console.log(`   Win Rate:              ${best.winRate.toFixed(1)}%`);
    console.log(
      `   Total PnL (NET):       ${best.totalPnlPercent >= 0 ? '+' : ''}${best.totalPnlPercent.toFixed(2)}%`,
    );
    console.log(`   Max Drawdown:          ${best.maxDrawdown.toFixed(2)}%`);

    {
      const d = best.debugStats;
      console.log(`\n🔎 Best Diagnostics:`);
      console.log(
        `   debug: noSignal=${d.noSignal}, agentSkip=${d.agentSkip}, plannerReject=${d.plannerReject}, executed=${d.executed}`,
      );
      console.log(`   exits: ${formatExitReasonCounts(best.exitReasons)}`);
      console.log(`   topDecisionReasons: ${formatTopReasons(best.decisionTopReasons)}`);
    }

    console.log(`\n📝 Config Code:`);
    console.log(`   '${symbol}': {`);
    console.log(`     atrMultiplier: ${best.atrMultiplier},`);
    console.log(`     priceSurgePct: ${best.priceSurgePct},`);
    console.log(`     volumeSpikeMultiplier: ${best.volumeSpikeMultiplier},`);
    console.log(`     rsiLower: ${s.rsiLower},`);
    console.log(`     swingLookback: ${s.swingLookback},`);
    console.log(`     rr: ${s.rr},`);
    console.log(`     stopBufferPct: ${s.stopBufferPct},`);
    console.log(`     beTriggerR: ${s.beTriggerR},`);
    console.log(`   },`);
  } else {
    console.log(`\n⚠️ No viable configurations found (need trades>=5 and NET PnL% > 0)`);
  }
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('   📊 Volatility Parameter Optimization   ');
  console.log('═══════════════════════════════════════════');

  const symbolsRaw = process.env.SYMBOLS || process.env.SYMBOL || 'KRW-BTC';
  const symbols = symbolsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`\nSymbols to optimize: ${symbols.join(', ')}\n`);

  for (const symbol of symbols) {
    try {
      await optimizeSymbol(symbol);
    } catch (error) {
      console.error(`❌ Failed to optimize ${symbol}:`, error);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('✅ Optimization Complete');
  console.log(`${'═'.repeat(60)}`);
}

main().catch(console.error);
