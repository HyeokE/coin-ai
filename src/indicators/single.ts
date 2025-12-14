/**
 * 단일값 지표 함수들
 * - 시리즈 함수를 래핑하여 마지막 값만 반환
 * - TradingBotWS 등 실시간 트레이딩에서 사용
 */

import { Candle } from '../types';
import { smaSeries, emaSeries, rsiSeries, atrSeries } from './series';

/**
 * RSI (Relative Strength Index) - Wilder Smoothing
 * @returns 0-100 사이의 값
 */
export function calculateRSI(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50;

  const closes = candles.map((c) => c.close);
  const series = rsiSeries(closes, period);
  return series[series.length - 1];
}

/**
 * SMA (Simple Moving Average)
 */
export function calculateSMA(candles: Candle[], period: number): number {
  if (candles.length < period) return 0;

  const closes = candles.map((c) => c.close);
  const series = smaSeries(closes, period);
  return series[series.length - 1];
}

/**
 * EMA (Exponential Moving Average)
 */
export function calculateEMA(candles: Candle[], period: number): number {
  if (candles.length < period) return 0;

  const closes = candles.map((c) => c.close);
  const series = emaSeries(closes, period);
  return series[series.length - 1];
}

/**
 * ATR (Average True Range) - Wilder Smoothing
 */
export function calculateATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;

  const series = atrSeries(candles, period);
  return series[series.length - 1];
}
