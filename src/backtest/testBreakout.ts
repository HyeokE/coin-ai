import { getSymbolRiskPolicy, GLOBAL_CONFIG } from '../config/config';
import { MarketDataService } from '../market/MarketDataService';
import { Candle, VolatilitySignal } from '../types';
import { BacktestSimulator, BacktestTrade, DebugStats, DecisionProvider, SimulatedPosition } from './BacktestSimulator';
import { emaSeries, rsiSeries, atrSeries } from '../indicators';
import { createBreakoutStrategyProvider } from './strategies/breakoutStrategy';
import { BreakoutMode } from '../strategies/breakoutEntry';
import { CandleUnit } from '../models/upbit';

type ExitReason = BacktestTrade['exitReason'];
type ExitReasonCounts = Record<ExitReason, number>;
type DecisionReasonCounts = Map<string, number>;

function bumpReason(map: DecisionReasonCounts, reason: string): void {
  map.set(reason, (map.get(reason) ?? 0) + 1);
}

function topReasons(map: DecisionReasonCounts, n: number): { reason: string; count: number }[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([reason, count]) => ({ reason, count }));
}

interface TradeAnalysis {
  avgWinR: number;
  avgLossR: number;
  beRate: number;
  expectancy: number;
  theoreticalBe: number;
}

interface RegimeStats {
  trendPct: number;
  volPct: number;
  rangeRatio: number;
}

interface SegmentAnalysis {
  name: string;
  startIdx: number;
  endIdx: number;
  startDate: string;
  endDate: string;
  trades: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  beRate: number;
  expectancy: number;
  regime: RegimeStats;
}

interface BootstrapCI {
  p5: number;
  p50: number;
  p95: number;
  safeForLive: boolean;
}

interface WalkForwardReport {
  segments: SegmentAnalysis[];
  combined: SegmentAnalysis;
  bootstrap: BootstrapCI;
}

interface TestResult {
  trades: number;
  winRate: number;
  totalPnlPercent: number;
  maxDrawdown: number;
  avgStopDistance: number;
  feeInR: number;
  exits: ExitReasonCounts;
  topReasons: { reason: string; count: number }[];
  debug: DebugStats;
  analysis: TradeAnalysis;
  walkForward?: WalkForwardReport;
}

interface RAnalysisResult extends TradeAnalysis {
  winCount: number;
  lossCount: number;
  beCount: number;
  rMultiples: number[];
}

function computeRMultipleAnalysis(args: {
  trades: BacktestTrade[];
  atr: number[];
  closes: number[];
  atrMult: number;
  avgStopDistancePctFallback: number;
  feeRate: number;
  slippagePct: number;
  beBandR?: number;
}): RAnalysisResult {
  const {
    trades,
    atr,
    closes,
    atrMult,
    avgStopDistancePctFallback,
    feeRate,
    slippagePct,
    beBandR = 0.15,
  } = args;

  const slippage = slippagePct / 100;
  const totalFrictionPct = (feeRate * 2 + slippage * 2) * 100;

  let winRsum = 0;
  let winCount = 0;
  let lossRsum = 0;
  let lossCount = 0;
  let beCount = 0;
  const rMultiples: number[] = [];

  for (const t of trades) {
    const idx = t.entryIndex;
    const stopDist =
      atr[idx] > 0
        ? (atrMult * atr[idx]) / closes[idx]
        : avgStopDistancePctFallback / 100;

    const riskPct = stopDist * 100;
    const priceChangePct = ((t.exitPrice - t.entryPrice) / t.entryPrice) * 100;
    const netChangePct = priceChangePct - totalFrictionPct;
    const rMultiple = riskPct > 0 ? netChangePct / riskPct : 0;

    rMultiples.push(rMultiple);

    if (Math.abs(rMultiple) < beBandR) {
      beCount++;
    } else if (rMultiple > 0) {
      winRsum += rMultiple;
      winCount++;
    } else {
      lossRsum += Math.abs(rMultiple);
      lossCount++;
    }
  }

  const total = trades.length;
  const avgWinR = winCount > 0 ? winRsum / winCount : 0;
  const avgLossR = lossCount > 0 ? lossRsum / lossCount : 1;
  const beRate = total > 0 ? (beCount / total) * 100 : 0;

  const winRate = total > 0 ? winCount / total : 0;
  const lossRate = total > 0 ? lossCount / total : 0;

  const expectancy = winRate * avgWinR - lossRate * avgLossR;
  const theoreticalBe = avgWinR > 0 ? avgLossR / (avgWinR + avgLossR) : 0.5;

  return {
    avgWinR,
    avgLossR,
    beRate,
    expectancy,
    theoreticalBe: theoreticalBe * 100,
    winCount,
    lossCount,
    beCount,
    rMultiples,
  };
}

function computeRegimeStats(
  candles: Candle[],
  ema200: number[],
  atr: number[],
  startIdx: number,
  endIdx: number,
): RegimeStats {
  const segmentCandles = candles.slice(startIdx, endIdx);
  const segmentEma200 = ema200.slice(startIdx, endIdx);
  const segmentAtr = atr.slice(startIdx, endIdx);
  const segmentCloses = segmentCandles.map((c) => c.close);

  let trendSum = 0;
  let volSum = 0;
  let count = 0;

  for (let i = 0; i < segmentCandles.length; i++) {
    if (segmentEma200[i] > 0) {
      trendSum += segmentCloses[i] / segmentEma200[i];
      count++;
    }
    if (segmentCloses[i] > 0 && segmentAtr[i] > 0) {
      volSum += segmentAtr[i] / segmentCloses[i];
    }
  }

  const trendPct = count > 0 ? ((trendSum / count - 1) * 100) : 0;
  const volPct = count > 0 ? ((volSum / count) * 100) : 0;

  const highs = segmentCandles.map((c) => c.high);
  const lows = segmentCandles.map((c) => c.low);
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const avgClose = segmentCloses.reduce((a, b) => a + b, 0) / segmentCloses.length;
  const rangeRatio = avgClose > 0 ? ((maxHigh - minLow) / avgClose) * 100 : 0;

  return { trendPct, volPct, rangeRatio };
}

function bootstrapExpectancyCI(rMultiples: number[], iterations = 1000): BootstrapCI {
  if (rMultiples.length < 10) {
    return { p5: 0, p50: 0, p95: 0, safeForLive: false };
  }

  const expectations: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const sample: number[] = [];
    for (let j = 0; j < rMultiples.length; j++) {
      const idx = Math.floor(Math.random() * rMultiples.length);
      sample.push(rMultiples[idx]);
    }
    const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
    expectations.push(mean);
  }

  expectations.sort((a, b) => a - b);

  const p5 = expectations[Math.floor(iterations * 0.05)];
  const p50 = expectations[Math.floor(iterations * 0.50)];
  const p95 = expectations[Math.floor(iterations * 0.95)];

  return {
    p5,
    p50,
    p95,
    safeForLive: p5 > 0,
  };
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function computeWalkForwardReport(args: {
  trades: BacktestTrade[];
  candles: Candle[];
  ema200: number[];
  atr: number[];
  closes: number[];
  atrMult: number;
  avgStopDistancePctFallback: number;
  feeRate: number;
  slippagePct: number;
  segments?: number;
  beBandR?: number;
}): WalkForwardReport {
  const {
    trades,
    candles,
    ema200,
    atr,
    closes,
    atrMult,
    avgStopDistancePctFallback,
    feeRate,
    slippagePct,
    segments = 3,
    beBandR,
  } = args;

  const len = candles.length;
  const startTs = candles[0].timestamp;
  const endTs = candles[len - 1].timestamp;
  const totalDuration = endTs - startTs;
  const segmentDuration = totalDuration / segments;

  const segs: SegmentAnalysis[] = [];

  for (let i = 0; i < segments; i++) {
    const segStartTs = startTs + i * segmentDuration;
    const segEndTs = i === segments - 1 ? endTs + 1 : startTs + (i + 1) * segmentDuration;

    let startIdx = 0;
    let endIdx = len;
    for (let j = 0; j < len; j++) {
      if (candles[j].timestamp >= segStartTs && startIdx === 0) {
        startIdx = j;
      }
      if (candles[j].timestamp >= segEndTs) {
        endIdx = j;
        break;
      }
    }

    const segTrades = trades.filter((t) => {
      const entryTs = candles[t.entryIndex]?.timestamp ?? 0;
      return entryTs >= segStartTs && entryTs < segEndTs;
    });

    const a = computeRMultipleAnalysis({
      trades: segTrades,
      atr,
      closes,
      atrMult,
      avgStopDistancePctFallback,
      feeRate,
      slippagePct,
      beBandR,
    });

    const winRatePct = segTrades.length > 0 ? (a.winCount / segTrades.length) * 100 : 0;
    const regime = computeRegimeStats(candles, ema200, atr, startIdx, endIdx);

    segs.push({
      name: `S${i + 1}`,
      startIdx,
      endIdx,
      startDate: formatDate(segStartTs),
      endDate: formatDate(segEndTs),
      trades: segTrades.length,
      winRate: winRatePct,
      avgWinR: a.avgWinR,
      avgLossR: a.avgLossR,
      beRate: a.beRate,
      expectancy: a.expectancy,
      regime,
    });
  }

  const overall = computeRMultipleAnalysis({
    trades,
    atr,
    closes,
    atrMult,
    avgStopDistancePctFallback,
    feeRate,
    slippagePct,
    beBandR,
  });

  const overallWinRatePct = trades.length > 0 ? (overall.winCount / trades.length) * 100 : 0;
  const overallRegime = computeRegimeStats(candles, ema200, atr, 0, len);

  const bootstrap = bootstrapExpectancyCI(overall.rMultiples);

  return {
    segments: segs,
    combined: {
      name: 'ALL',
      startIdx: 0,
      endIdx: len,
      startDate: formatDate(startTs),
      endDate: formatDate(endTs),
      trades: trades.length,
      winRate: overallWinRatePct,
      avgWinR: overall.avgWinR,
      avgLossR: overall.avgLossR,
      beRate: overall.beRate,
      expectancy: overall.expectancy,
      regime: overallRegime,
    },
    bootstrap,
  };
}

async function testBreakout(symbol: string): Promise<TestResult> {
  const candleMinutes = parseInt(process.env.TF || '60', 10) as CandleUnit;
  const candleCount = parseInt(process.env.CANDLE_COUNT || '30000', 10);
  const mode = (process.env.MODE || 'immediate') as BreakoutMode;
  const retestLookback = parseInt(process.env.RETEST_LOOKBACK || '5', 10);

  const tfLabel = candleMinutes >= 60 ? `${candleMinutes / 60}H` : `${candleMinutes}m`;

  console.log(`\n📊 Testing Breakout (${mode}) on ${symbol} [${tfLabel}]`);
  console.log(`   Fetching ${candleCount.toLocaleString()} candles...`);

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

  const rsiMin = parseFloat(process.env.RSI_MIN || '55');
  const atrMult = parseFloat(process.env.ATR_MULT || '1.5');
  const rr = parseFloat(process.env.RR || '2.0');
  const beTriggerR = parseFloat(process.env.BE_TRIGGER || '0.5');

  console.log(`   Config: MODE=${mode}, RSI_MIN=${rsiMin}, ATR_MULT=${atrMult}, RR=${rr}, BE_TRIGGER=${beTriggerR}`);

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
    rsiMin,
    atrMultiplier: atrMult,
    rr,
    mode,
    retestLookback,
    idxMap,
  };

  const baseProvider = createBreakoutStrategyProvider(pre);
  const reasonCounts: DecisionReasonCounts = new Map();

  const wrappedProvider: DecisionProvider = (
    candlesWindow: Candle[],
    signal: VolatilitySignal | null,
    position: SimulatedPosition | null,
  ) => {
    const decision = baseProvider(candlesWindow, signal, position);
    if (!decision.shouldTrade && decision.reasoning) {
      bumpReason(reasonCounts, decision.reasoning);
    }
    return decision;
  };

  const policy = getSymbolRiskPolicy(symbol);

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
    beTriggerR,
  });

  const result = sim.run(candles, wrappedProvider);

  const wins = result.trades.filter((t) => t.pnlPercent > 0).length;
  const total = result.trades.length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  const exits: ExitReasonCounts = {
    TAKE_PROFIT: 0,
    STOP_LOSS: 0,
    END: 0,
    SIGNAL: 0,
  };
  for (const t of result.trades) {
    exits[t.exitReason]++;
  }

  let totalStopDist = 0;
  let stopDistCount = 0;
  for (let i = 0; i < result.trades.length; i++) {
    const idx = result.trades[i].entryIndex;
    if (atr[idx] > 0) {
      totalStopDist += (atrMult * atr[idx]) / closes[idx];
      stopDistCount++;
    }
  }
  const avgStopDistance = stopDistCount > 0 ? (totalStopDist / stopDistCount) * 100 : 0;
  const feeInR = avgStopDistance > 0 ? (feeRate * 2 * 100) / avgStopDistance : 999;

  const slippagePct = parseFloat(process.env.SLIPPAGE || '0.02');
  const beBandR = parseFloat(process.env.BE_BAND_R || '0.15');

  const analysis = computeRMultipleAnalysis({
    trades: result.trades,
    atr,
    closes,
    atrMult,
    avgStopDistancePctFallback: avgStopDistance,
    feeRate,
    slippagePct,
    beBandR,
  });

  const walkForward = computeWalkForwardReport({
    trades: result.trades,
    candles,
    ema200,
    atr,
    closes,
    atrMult,
    avgStopDistancePctFallback: avgStopDistance,
    feeRate,
    slippagePct,
    segments: parseInt(process.env.WF_SEGMENTS || '3', 10),
    beBandR,
  });

  return {
    trades: total,
    winRate,
    totalPnlPercent: result.totalPnlPercent,
    maxDrawdown: result.maxDrawdown,
    avgStopDistance,
    feeInR,
    exits,
    topReasons: topReasons(reasonCounts, 8),
    debug: result.debugStats,
    analysis,
    walkForward,
  };
}

async function main() {
  const symbols = (process.env.SYMBOLS || 'KRW-BTC').split(',').map((s) => s.trim());
  const tfLabel = parseInt(process.env.TF || '60', 10) >= 60 
    ? `${parseInt(process.env.TF || '60', 10) / 60}H` 
    : `${process.env.TF || '60'}m`;
  const mode = process.env.MODE || 'immediate';

  console.log('═══════════════════════════════════════════');
  console.log(`   🚀 Breakout v2 Test (${mode}, ${tfLabel})`);
  console.log('═══════════════════════════════════════════');

  const slippage = process.env.SLIPPAGE || '0.02';

  for (const symbol of symbols) {
    const result = await testBreakout(symbol);
    const a = result.analysis;

    console.log(`\n📈 Results for ${symbol}:`);
    console.log(`${'─'.repeat(50)}`);
    console.log(`   Trades: ${result.trades}`);
    console.log(`   Win Rate: ${result.winRate.toFixed(1)}%`);
    console.log(`   PnL: ${result.totalPnlPercent.toFixed(2)}%`);
    console.log(`   Risk/Trade: ${process.env.RISK_PER_TRADE_PCT || '0.02'}, RiskScale: ${process.env.RISK_SCALE || '1.0'}`);
    console.log(`   Max DD: ${result.maxDrawdown.toFixed(2)}%`);
    console.log(`   Avg Stop%: ${result.avgStopDistance.toFixed(3)}%`);
    console.log(`   Fee+Slip in R: ${result.feeInR.toFixed(2)}R (slip=${slippage}%)`);
    console.log(`   Exits: TP=${result.exits.TAKE_PROFIT}, SL=${result.exits.STOP_LOSS}, END=${result.exits.END}`);

    console.log(`\n📊 R-Multiple Analysis:`);
    console.log(`${'─'.repeat(50)}`);
    console.log(`   Avg Win R: +${a.avgWinR.toFixed(2)}R`);
    console.log(`   Avg Loss R: -${a.avgLossR.toFixed(2)}R`);
    console.log(`   BE Rate: ${a.beRate.toFixed(1)}% (trades near 0R)`);
    console.log(`   Expectancy: ${a.expectancy >= 0 ? '+' : ''}${a.expectancy.toFixed(3)}R per trade`);
    console.log(`   Theoretical BE Win%: ${a.theoreticalBe.toFixed(1)}% (if BE rate=0)`);
    const hasEdge = a.expectancy > 0;
    console.log(`   Actual Win%: ${result.winRate.toFixed(1)}% → ${hasEdge ? '✅ EDGE (+' + a.expectancy.toFixed(3) + 'R)' : '❌ NO EDGE'}`);

    if (hasEdge) {
      console.log(`\n   ✅ Why profitable with ${result.winRate.toFixed(1)}% win rate:`);
      if (a.avgLossR < 1) {
        console.log(`      • Avg loss (${a.avgLossR.toFixed(2)}R) < 1R → BE cuts losses`);
      }
      if (a.avgWinR > 3) {
        console.log(`      • Avg win (${a.avgWinR.toFixed(2)}R) > 3R → Winners run`);
      }
      if (a.beRate > 5) {
        console.log(`      • BE rate ${a.beRate.toFixed(1)}% → Many scratch trades`);
      }
    }

    if (result.walkForward) {
      const wf = result.walkForward;
      console.log(`\n🧪 Walk-Forward (${wf.segments.length} segments, timestamp-based):`);
      console.log(`${'─'.repeat(110)}`);
      console.log(` Seg  Period               Trades  Win%   AvgWin  AvgLoss  BE%    Exp      │ Trend   Vol%   Range%`);
      console.log(`${'─'.repeat(110)}`);
      
      for (const s of wf.segments) {
        const expSign = s.expectancy >= 0 ? '+' : '';
        const trendSign = s.regime.trendPct >= 0 ? '+' : '';
        console.log(
          ` ${s.name}   ${s.startDate}~${s.endDate}  ` +
          `${String(s.trades).padStart(4)}  ${s.winRate.toFixed(1).padStart(5)}%  ` +
          `${s.avgWinR.toFixed(2)}R   ${s.avgLossR.toFixed(2)}R    ${s.beRate.toFixed(1).padStart(4)}%  ` +
          `${expSign}${s.expectancy.toFixed(3)}R  │ ` +
          `${trendSign}${s.regime.trendPct.toFixed(1).padStart(5)}%  ${s.regime.volPct.toFixed(2).padStart(5)}%  ${s.regime.rangeRatio.toFixed(1).padStart(5)}%`
        );
      }
      
      const c = wf.combined;
      const cExpSign = c.expectancy >= 0 ? '+' : '';
      const cTrendSign = c.regime.trendPct >= 0 ? '+' : '';
      console.log(`${'─'.repeat(110)}`);
      console.log(
        ` ALL  ${c.startDate}~${c.endDate}  ` +
        `${String(c.trades).padStart(4)}  ${c.winRate.toFixed(1).padStart(5)}%  ` +
        `${c.avgWinR.toFixed(2)}R   ${c.avgLossR.toFixed(2)}R    ${c.beRate.toFixed(1).padStart(4)}%  ` +
        `${cExpSign}${c.expectancy.toFixed(3)}R  │ ` +
        `${cTrendSign}${c.regime.trendPct.toFixed(1).padStart(5)}%  ${c.regime.volPct.toFixed(2).padStart(5)}%  ${c.regime.rangeRatio.toFixed(1).padStart(5)}%`
      );

      console.log(`\n📈 Bootstrap CI (1000 iterations):`);
      console.log(`${'─'.repeat(50)}`);
      const bs = wf.bootstrap;
      console.log(`   5th percentile:  ${bs.p5 >= 0 ? '+' : ''}${bs.p5.toFixed(3)}R`);
      console.log(`   50th percentile: ${bs.p50 >= 0 ? '+' : ''}${bs.p50.toFixed(3)}R`);
      console.log(`   95th percentile: ${bs.p95 >= 0 ? '+' : ''}${bs.p95.toFixed(3)}R`);
      console.log(`   Safe for live:   ${bs.safeForLive ? '✅ YES (5th > 0)' : '⚠️  NO (5th <= 0)'}`);

      const allPos = wf.segments.every((x) => x.trades >= 30 && x.expectancy > 0);
      const lowTrades = wf.segments.some((x) => x.trades < 30);
      const negExp = wf.segments.some((x) => x.expectancy <= 0);

      console.log(`\n🎯 Walk-Forward Summary:`);
      if (!allPos) {
        console.log(`   ⚠️  Warning:`);
        if (lowTrades) console.log(`      • Some segments have < 30 trades (statistically weak)`);
        if (negExp) console.log(`      • Some segments have negative expectancy (overfit risk)`);
      } else if (bs.safeForLive) {
        console.log(`   ✅ READY FOR LIVE: All segments positive + Bootstrap CI safe`);
      } else {
        console.log(`   ⚠️  CAUTION: Segments OK but Bootstrap 5th percentile <= 0`);
      }
    }
  }

  console.log('\n✅ Test Complete');
}

main().catch(console.error);
