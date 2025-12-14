import { getSymbolRiskPolicy, GLOBAL_CONFIG } from '../config/config';
import { MarketDataService } from '../market/MarketDataService';
import { Candle, VolatilitySignal } from '../types';
import { BacktestSimulator, BacktestResult, DecisionProvider, SimulatedPosition } from './BacktestSimulator';
import { emaSeries, rsiSeries, atrSeries } from '../indicators';
import { createBreakoutStrategyProvider } from './strategies/breakoutStrategy';
import { BreakoutMode } from '../strategies/breakoutEntry';
import { CandleUnit } from '../models/upbit';

interface BreakoutParams {
  rsiMin: number;
  atrMult: number;
  rr: number;
  beTrigger: number;
  mode: BreakoutMode;
  retestLookback: number;
}

interface Candidate {
  params: BreakoutParams;
  avgPnl: number;
  avgWinRate: number;
  avgTrades: number;
  consistency: number;
}

function envNumList(key: string, def: number[]): number[] {
  const v = process.env[key];
  if (!v) return def;
  return v.split(',').map((x) => parseFloat(x.trim())).filter((n) => !isNaN(n));
}

function generateParamCombos(): BreakoutParams[] {
  const rsiMins = envNumList('OPT_RSI_MINS', [50, 55]);
  const atrMults = envNumList('OPT_ATR_MULTS', [1.5, 2.0, 2.5]);
  const rrs = envNumList('OPT_RRS', [1.5, 2.0, 2.5]);
  const beTriggers = envNumList('OPT_BE_TRIGGERS', [0.25, 0.5]);
  const modes: BreakoutMode[] = ['retest'];
  const retestLookback = parseInt(process.env.RETEST_LOOKBACK || '5', 10);

  const combos: BreakoutParams[] = [];
  for (const rsiMin of rsiMins) {
    for (const atrMult of atrMults) {
      for (const rr of rrs) {
        for (const beTrigger of beTriggers) {
          for (const mode of modes) {
            combos.push({ rsiMin, atrMult, rr, beTrigger, mode, retestLookback });
          }
        }
      }
    }
  }
  return combos;
}

function createFolds(n: number, k: number): { start: number; end: number }[] {
  const size = Math.floor(n / k);
  const folds: { start: number; end: number }[] = [];
  for (let i = 0; i < k; i++) {
    folds.push({ start: i * size, end: (i + 1) * size });
  }
  return folds;
}

async function optimizeSymbol(symbol: string) {
  const candleMinutes = parseInt(process.env.TF || '60', 10) as CandleUnit;
  const candleCount = parseInt(process.env.CANDLE_COUNT || '30000', 10);
  const tfLabel = candleMinutes >= 60 ? `${candleMinutes / 60}H` : `${candleMinutes}m`;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`   🔍 Optimizing Breakout for ${symbol} [${tfLabel}]`);
  console.log(`${'═'.repeat(60)}`);

  const t0 = Date.now();
  const market = MarketDataService.createSimple(symbol);
  const candles = await market.fetchCandlesPaginated(symbol, 'minutes', candleCount, candleMinutes);
  console.log(`   Loaded ${candles.length.toLocaleString()} candles in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const closes = candles.map((c: Candle) => c.close);
  const highs = candles.map((c: Candle) => c.high);
  const lows = candles.map((c: Candle) => c.low);
  const feeRate = GLOBAL_CONFIG.feeRate;

  console.log(`\n🧮 Precomputing indicators...`);
  const ema200 = emaSeries(closes, 200);
  const ribbonPeriods = [20, 25, 30, 35, 40, 45, 50, 60];
  const ribbon = ribbonPeriods.map((p) => emaSeries(closes, p));
  const rsi = rsiSeries(closes, 14);
  const atr = atrSeries(candles, 14);

  const idxMap = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) {
    idxMap.set(candles[i].timestamp, i);
  }

  const combos = generateParamCombos();
  console.log(`   Testing ${combos.length} parameter combinations...`);

  const folds = createFolds(candles.length, 3);
  const policy = getSymbolRiskPolicy(symbol);

  const candidates: Candidate[] = [];
  let progress = 0;

  for (const params of combos) {
    const scores: { pnl: number; winRate: number; trades: number }[] = [];

    for (const fold of folds) {
      const pre = {
        candles,
        closes,
        highs,
        lows,
        ema200,
        ribbon,
        rsi,
        atr,
        feeRate,
        rsiMin: params.rsiMin,
        atrMultiplier: params.atrMult,
        rr: params.rr,
        mode: params.mode,
        retestLookback: params.retestLookback,
        idxMap,
      };

      const provider = createBreakoutStrategyProvider(pre);

      const sim = new BacktestSimulator({
        symbol,
        initialCapitalKrw: 10_000_000,
        riskPolicy: policy,
        volatilityThresholds: {
          atrMultiplier: 0.6,
          priceSurgePct: 0.003,
          volumeSpikeMultiplier: 1.2,
        },
        feeRate,
        beTriggerR: params.beTrigger,
      });

      const result = sim.runRange(candles, fold.start, fold.end, provider);
      const wins = result.trades.filter((t) => t.pnlPercent > 0).length;
      const total = result.trades.length;

      scores.push({
        pnl: result.totalPnlPercent,
        winRate: total > 0 ? wins / total : 0,
        trades: total,
      });
    }

    const avgPnl = scores.reduce((s, x) => s + x.pnl, 0) / scores.length;
    const avgWinRate = scores.reduce((s, x) => s + x.winRate, 0) / scores.length;
    const avgTrades = scores.reduce((s, x) => s + x.trades, 0) / scores.length;

    const variance = scores.reduce((s, x) => s + (x.pnl - avgPnl) ** 2, 0) / scores.length;
    const std = Math.sqrt(variance);
    const consistency = Math.abs(avgPnl) > 0.01 ? 1 - Math.min(std / Math.abs(avgPnl), 1) : 0.5;

    candidates.push({ params, avgPnl, avgWinRate, avgTrades, consistency });

    progress++;
    if (progress % 10 === 0) {
      process.stdout.write(`   Progress: ${progress}/${combos.length}\r`);
    }
  }

  console.log(`\n\n📊 Top 10 Configurations:`);
  console.log(`${'─'.repeat(100)}`);

  candidates.sort((a, b) => b.avgPnl - a.avgPnl);
  const top10 = candidates.slice(0, 10);

  console.log(
    `${'Rank'.padStart(4)} | ` +
    `${'RSI'.padStart(4)} | ` +
    `${'ATR'.padStart(4)} | ` +
    `${'RR'.padStart(4)} | ` +
    `${'BE'.padStart(5)} | ` +
    `${'Mode'.padEnd(10)} | ` +
    `${'AvgPnl%'.padStart(9)} | ` +
    `${'WinRate'.padStart(8)} | ` +
    `${'Trades'.padStart(7)} | ` +
    `${'Consist'.padStart(8)}`
  );
  console.log(`${'─'.repeat(100)}`);

  for (let i = 0; i < top10.length; i++) {
    const c = top10[i];
    console.log(
      `${(i + 1).toString().padStart(4)} | ` +
      `${c.params.rsiMin.toString().padStart(4)} | ` +
      `${c.params.atrMult.toFixed(1).padStart(4)} | ` +
      `${c.params.rr.toFixed(1).padStart(4)} | ` +
      `${c.params.beTrigger.toFixed(2).padStart(5)} | ` +
      `${c.params.mode.padEnd(10)} | ` +
      `${c.avgPnl.toFixed(2).padStart(8)}% | ` +
      `${(c.avgWinRate * 100).toFixed(1).padStart(7)}% | ` +
      `${c.avgTrades.toFixed(0).padStart(7)} | ` +
      `${c.consistency.toFixed(2).padStart(8)}`
    );
  }

  console.log(`${'─'.repeat(100)}`);

  const best = top10[0];
  console.log(`\n✅ Best Configuration for ${symbol}:`);
  console.log(`   RSI_MIN=${best.params.rsiMin}`);
  console.log(`   ATR_MULT=${best.params.atrMult}`);
  console.log(`   RR=${best.params.rr}`);
  console.log(`   BE_TRIGGER=${best.params.beTrigger}`);
  console.log(`   MODE=${best.params.mode}`);
  console.log(`   Avg PnL: ${best.avgPnl.toFixed(2)}%`);
  console.log(`   Avg Win Rate: ${(best.avgWinRate * 100).toFixed(1)}%`);

  return best;
}

async function main() {
  const symbols = (process.env.SYMBOLS || 'KRW-BTC').split(',').map((s) => s.trim());

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   🚀 Breakout Strategy Optimization');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`   Symbols: ${symbols.join(', ')}`);
  console.log(`   TF: ${process.env.TF || '60'}min`);

  for (const symbol of symbols) {
    await optimizeSymbol(symbol);
  }

  console.log('\n✅ Optimization Complete');
}

main().catch(console.error);

