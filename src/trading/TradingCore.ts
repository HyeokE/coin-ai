import { Candle, VolatilitySignal, Position, TradeSide } from '../types';

/**
 * 공통 지표 계산 + 시그널 감지 + 청산 조건 체크
 * - BacktestSimulator / TradingBotWS 둘 다 이걸 사용
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

export function calculateRSI(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50;
  const recent = candles.slice(-(period + 1));
  let gains = 0,
    losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const change = recent[i].close - recent[i - 1].close;
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function calculateSMA(candles: Candle[], period: number): number {
  if (candles.length < period) return 0;
  const recent = candles.slice(-period);
  return recent.reduce((sum, c) => sum + c.close, 0) / period;
}

export function calculateEMA(candles: Candle[], period: number): number {
  if (candles.length < period) return 0;
  const multiplier = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = (candles[i].close - ema) * multiplier + ema;
  }
  return ema;
}

export function calculateATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const recent = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < recent.length; i++) {
    const tr = Math.max(
      recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i - 1].close),
      Math.abs(recent[i].low - recent[i - 1].close),
    );
    sum += tr;
  }
  return sum / period;
}

/**
 * 변동성 시그널 감지
 * - ATR_SPIKE: 평소 ATR의 N배 이상
 * - PRICE_SURGE: 직전 캔들 대비 N% 이상 움직임
 */
export function detectVolatilitySignal(
  candles: Candle[],
  thresholds: VolatilityThresholds,
): VolatilitySignal | null {
  if (candles.length < 30) return null;

  const recent14 = candles.slice(-14);
  const atr = calculateATR(candles, 14);
  const avgAtr = calculateATR(candles.slice(-30), 14);
  const last = candles[candles.length - 1];
  const atrPercent = atr / last.close;

  // ATR SPIKE
  if (atr > avgAtr * thresholds.atrMultiplier) {
    const direction = recent14[recent14.length - 1].close > recent14[0].close ? 'UP' : 'DOWN';
    return {
      type: 'ATR_SPIKE',
      value: atr,
      threshold: avgAtr * thresholds.atrMultiplier,
      direction,
      timestamp: last.timestamp ?? Date.now(),
      atrPercent,
    };
  }

  // PRICE SURGE
  const prev = candles[candles.length - 2];
  const priceChangePct = (last.close - prev.close) / prev.close;

  if (Math.abs(priceChangePct) > thresholds.priceSurgePct) {
    return {
      type: 'PRICE_SURGE',
      value: Math.abs(priceChangePct) * 100,
      threshold: thresholds.priceSurgePct * 100,
      direction: priceChangePct > 0 ? 'UP' : 'DOWN',
      timestamp: last.timestamp ?? Date.now(),
      atrPercent,
    };
  }

  return null;
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
 * PnL 계산
 */
export function calculatePnl(
  position: Position,
  exitPrice: number,
): { pnl: number; pnlPercent: number } {
  const { side, entryPrice, quantity } = position;
  const direction = side === TradeSide.LONG ? 1 : -1;
  const pnl = (exitPrice - entryPrice) * quantity * direction;
  const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100 * direction;
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
 * Unrealized PnL 업데이트
 */
export function calculateUnrealizedPnl(position: Position, currentPrice: number): number {
  const direction = position.side === TradeSide.LONG ? 1 : -1;
  return ((currentPrice - position.entryPrice) / position.entryPrice) * 100 * direction;
}
