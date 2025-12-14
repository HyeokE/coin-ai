import { Candle, VolatilitySignal, Position, TradeSide } from '../types';
import { GLOBAL_CONFIG } from '../config/config';

import { calculateATR, calculateEMA, calculateRSI, calculateSMA } from '../indicators';

export { calculateRSI, calculateSMA, calculateEMA, calculateATR };

/**
 * 공통 지표 계산 + 시그널 감지 + 청산 조건 체크
 * - BacktestSimulator / TradingBotWS 둘 다 이걸 사용
 * - 지표 함수는 src/indicators 모듈에서 통합 관리 (Wilder smoothing)
 */

export interface VolatilityThresholds {
  atrMultiplier: number;
  priceSurgePct: number;
  volumeSpikeMultiplier: number;
}

export interface ExitCheckResult {
  shouldExit: boolean;
  reason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'SIGNAL' | null;
}
export function detectVolatilitySignal(
  candles: Candle[],
  thresholds: VolatilityThresholds,
): VolatilitySignal | null {
  return detectVolatilitySignalAt(candles, thresholds, candles.length - 1);
}

export function detectVolatilitySignalAt(
  candles: Candle[],
  thresholds: VolatilityThresholds,
  i: number,
): VolatilitySignal | null {
  // 원래 코드가 candles.length < 30 체크였으니 비슷하게 유지
  if (i < 30) return null;

  const last = candles[i];
  const prev = candles[i - 1];
  if (!last || !prev) return null;

  // atrMultiplier 의미: "평균 대비 +X" (0.6 = +60%)
  const atrPeriod = 14;
  const atr = calcAtrWilderWindow(candles, i, atrPeriod, atrPeriod + 1); // 최소한의 구간
  const avgAtr = calcAtrWilderWindow(candles, i, atrPeriod, 30); // 기존 slice(-30) 대응

  const atrPercent = atr / last.close;

  const signal = pickBestVolatilitySignal({ candles, thresholds, i, atr, avgAtr, atrPercent });
  if (signal) return signal;

  return null;
}

export interface StrongSignalFilterConfig {
  rsiPeriod: number;
  smaPeriod: number;
  emaPeriod: number;
  rsiLower: number;
  rsiUpper: number;
  emaSmaSpreadPct: number;
  minScore: number;
}

export function isStrongVolatilitySignal(
  candles: Candle[],
  signal: VolatilitySignal,
  config: StrongSignalFilterConfig = {
    rsiPeriod: 14,
    smaPeriod: 20,
    emaPeriod: 9,
    rsiLower: 35,
    rsiUpper: 65,
    emaSmaSpreadPct: 0.002,
    minScore: 2,
  },
): boolean {
  const rsi = calculateRSI(candles, config.rsiPeriod);
  const sma = calculateSMA(candles, config.smaPeriod);
  const ema = calculateEMA(candles, config.emaPeriod);

  let score = 0;
  if (Math.abs(signal.value) > signal.threshold) score++;
  if (rsi < config.rsiLower || rsi > config.rsiUpper) score++;
  if (sma > 0 && Math.abs(ema - sma) / sma > config.emaSmaSpreadPct) score++;
  return score >= config.minScore;
}

// ───────────────────────────────────────────────────────────────
// Wilder ATR를 "끝 인덱스 i" 기준, "windowLen" 구간만으로 계산 (할당 없음)
// - windowLen은 최소 period+1 이상 권장
// - 기존 calculateATR 구현이 Wilder가 아니라 SMA라면, 이 함수만 SMA로 바꾸면 됨
// ───────────────────────────────────────────────────────────────
function calcAtrWilderWindow(
  candles: Candle[],
  endIndex: number,
  period: number,
  windowLen: number,
): number {
  const start = Math.max(1, endIndex - windowLen + 1); // TR 계산에 prevClose 필요하니 최소 1
  const end = endIndex;

  // TR 배열을 만들지 않고 즉시 누적
  // 1) 첫 ATR: period개 TR의 SMA
  let trSum = 0;
  let trCount = 0;

  const initStart = Math.max(start, end - windowLen + 1);
  const initEnd = Math.min(end, initStart + period - 1);

  for (let k = initStart; k <= initEnd; k++) {
    const tr = trueRange(candles[k], candles[k - 1].close);
    trSum += tr;
    trCount++;
  }

  // period가 부족하면(초반 구간) 그냥 가능한 만큼으로
  let atr = trCount > 0 ? trSum / trCount : 0;

  // 2) Wilder smoothing
  // atr_t = (atr_{t-1}*(period-1) + tr_t) / period
  for (let k = initEnd + 1; k <= end; k++) {
    const tr = trueRange(candles[k], candles[k - 1].close);
    atr = (atr * (period - 1) + tr) / period;
  }

  return atr;
}

function trueRange(c: Candle, prevClose: number): number {
  const hl = c.high - c.low;
  const hc = Math.abs(c.high - prevClose);
  const lc = Math.abs(c.low - prevClose);
  return Math.max(hl, hc, lc);
}

type SignalCandidate = {
  strength: number;
  signal: VolatilitySignal;
};

function pickBestVolatilitySignal(args: {
  candles: Candle[];
  thresholds: VolatilityThresholds;
  i: number;
  atr: number;
  avgAtr: number;
  atrPercent: number;
}): VolatilitySignal | null {
  const { candles, thresholds, i, atr, avgAtr, atrPercent } = args;

  const last = candles[i];
  const prev = candles[i - 1];
  if (!last || !prev) return null;

  const candidates: SignalCandidate[] = [];

  const atrCandidate = buildAtrSpikeCandidate({ candles, thresholds, i, atr, avgAtr, atrPercent });
  if (atrCandidate) candidates.push(atrCandidate);

  const priceCandidate = buildPriceSurgeCandidate({ thresholds, last, prev, atrPercent });
  if (priceCandidate) candidates.push(priceCandidate);

  const volumeCandidate = buildVolumeSpikeCandidate({ candles, thresholds, i, atrPercent });
  if (volumeCandidate) candidates.push(volumeCandidate);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.strength - a.strength);
  return candidates[0].signal;
}

function buildAtrSpikeCandidate(args: {
  candles: Candle[];
  thresholds: VolatilityThresholds;
  i: number;
  atr: number;
  avgAtr: number;
  atrPercent: number;
}): SignalCandidate | null {
  const { candles, thresholds, i, atr, avgAtr, atrPercent } = args;
  if (avgAtr <= 0) return null;

  const threshold = avgAtr * (1 + thresholds.atrMultiplier);
  if (atr <= threshold) return null;

  const start14 = i - (14 - 1);
  const ref = candles[start14];
  const direction = ref && candles[i].close > ref.close ? 'UP' : 'DOWN';

  return {
    strength: atr / threshold,
    signal: {
      type: 'ATR_SPIKE',
      value: atr,
      threshold,
      direction,
      timestamp: candles[i].timestamp ?? Date.now(),
      atrPercent,
    },
  };
}

function buildPriceSurgeCandidate(args: {
  thresholds: VolatilityThresholds;
  last: Candle;
  prev: Candle;
  atrPercent: number;
}): SignalCandidate | null {
  const { thresholds, last, prev, atrPercent } = args;
  if (prev.close <= 0) return null;

  const priceChangePct = (last.close - prev.close) / prev.close;
  const absChange = Math.abs(priceChangePct);
  if (absChange <= thresholds.priceSurgePct) return null;

  return {
    strength: absChange / thresholds.priceSurgePct,
    signal: {
      type: 'PRICE_SURGE',
      value: absChange * 100,
      threshold: thresholds.priceSurgePct * 100,
      direction: priceChangePct > 0 ? 'UP' : 'DOWN',
      timestamp: last.timestamp ?? Date.now(),
      atrPercent,
    },
  };
}

function buildVolumeSpikeCandidate(args: {
  candles: Candle[];
  thresholds: VolatilityThresholds;
  i: number;
  atrPercent: number;
}): SignalCandidate | null {
  const { candles, thresholds, i, atrPercent } = args;
  const last = candles[i];
  if (!last) return null;

  const window = 30;
  const start = Math.max(0, i - window);
  const sample = candles.slice(start, i); // exclude last
  if (sample.length < 10) return null;

  const avgVol = sample.reduce((s, c) => s + c.volume, 0) / sample.length;
  if (avgVol <= 0) return null;

  const ratio = last.volume / avgVol;
  if (ratio <= thresholds.volumeSpikeMultiplier) return null;

  const direction = buildDirection3(candles, i);

  return {
    strength: ratio / thresholds.volumeSpikeMultiplier,
    signal: {
      type: 'VOLUME_SPIKE',
      value: ratio,
      threshold: thresholds.volumeSpikeMultiplier,
      direction,
      timestamp: last.timestamp ?? Date.now(),
      atrPercent,
    },
  };
}

function buildDirection3(candles: Candle[], i: number): 'UP' | 'DOWN' | 'NEUTRAL' {
  const start = Math.max(0, i - 2);
  const first = candles[start];
  const last = candles[i];
  if (!first || !last) return 'NEUTRAL';
  const change = last.close - first.open;
  if (change > 0) return 'UP';
  if (change < 0) return 'DOWN';
  return 'NEUTRAL';
}

/**
 * 포지션 청산 조건 체크
 * - OrderPlanner가 계산한 stopLoss / targetPrice 기준
 */
export function checkPositionExit(
  position: Position & { stopLoss?: number; targetPrice?: number },
  currentPrice: number,
): ExitCheckResult {
  const { side, stopLoss, targetPrice } = position;

  if (stopLoss !== undefined) {
    const hitStop = side === TradeSide.LONG ? currentPrice <= stopLoss : currentPrice >= stopLoss;
    if (hitStop) {
      return { shouldExit: true, reason: 'STOP_LOSS' };
    }
  }

  if (targetPrice !== undefined) {
    const hitTarget =
      side === TradeSide.LONG ? currentPrice >= targetPrice : currentPrice <= targetPrice;
    if (hitTarget) {
      return { shouldExit: true, reason: 'TAKE_PROFIT' };
    }
  }

  return { shouldExit: false, reason: null };
}

/**
 * PnL 계산 (수수료 반영)
 */
export function calculatePnl(
  position: Position,
  exitPrice: number,
  feeRate = GLOBAL_CONFIG.feeRate,
): { pnl: number; pnlPercent: number } {
  const { side, entryPrice, quantity } = position;
  const grossEntry = entryPrice * quantity;
  const grossExit = exitPrice * quantity;
  const entryFee = grossEntry * feeRate;
  const exitFee = grossExit * feeRate;

  let pnl: number;
  if (side === TradeSide.LONG) {
    pnl = grossExit - exitFee - (grossEntry + entryFee);
  } else {
    pnl = grossEntry * (1 - feeRate) - grossExit * (1 + feeRate);
  }

  const invested = grossEntry + entryFee;
  const pnlPercent = invested > 0 ? (pnl / invested) * 100 : 0;
  return { pnl, pnlPercent };
}

/**
 * 포지션 가치 계산
 */
export function calculatePositionValue(position: Position | null, currentPrice: number): number {
  if (!position) return 0;
  return position.quantity * currentPrice;
}

/**
 * Unrealized PnL 계산 (수수료 반영)
 */
export function calculateUnrealizedPnl(
  position: Position,
  currentPrice: number,
  feeRate = GLOBAL_CONFIG.feeRate,
): number {
  const { side, entryPrice, quantity } = position;
  const grossEntry = entryPrice * quantity;
  const grossCurrent = currentPrice * quantity;
  const entryFee = grossEntry * feeRate;
  const currentFee = grossCurrent * feeRate;

  let pnl: number;
  if (side === TradeSide.LONG) {
    pnl = grossCurrent - currentFee - (grossEntry + entryFee);
  } else {
    pnl = grossEntry * (1 - feeRate) - grossCurrent * (1 + feeRate);
  }

  const invested = grossEntry + entryFee;
  return invested > 0 ? (pnl / invested) * 100 : 0;
}
