import { Candle } from '../types';

/**
 * SMA (Simple Moving Average) 시리즈
 */
export function smaSeries(closes: number[], period: number): number[] {
  const n = closes.length;
  const out: number[] = new Array(n).fill(0);

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i];
    if (i >= period) {
      sum -= closes[i - period];
    }
    if (i >= period - 1) {
      out[i] = sum / period;
    }
  }

  return out;
}

/**
 * EMA (Exponential Moving Average) 시리즈
 */
export function emaSeries(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length);
  const k = 2 / (period + 1);
  let ema = closes[0];
  out[0] = ema;
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

export function rsiSeries(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(50);

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss += Math.abs(diff);
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;

    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return out;
}

export function atrSeries(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const out: number[] = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));

    if (i < period) {
      out[i] = out[i - 1] + tr / period;
    } else if (i === period) {
      let sum = 0;
      for (let j = 1; j <= period; j++) {
        const h = candles[j].high;
        const l = candles[j].low;
        const pc = candles[j - 1].close;
        sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }
      out[i] = sum / period;
    } else {
      out[i] = (out[i - 1] * (period - 1) + tr) / period;
    }
  }

  return out;
}

export function rocSeries(closes: number[], period: number): number[] {
  const n = closes.length;
  const out: number[] = new Array(n).fill(0);
  for (let i = period; i < n; i++) {
    out[i] = ((closes[i] - closes[i - period]) / closes[i - period]) * 100;
  }
  return out;
}

export function cciSeries(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const out: number[] = new Array(n).fill(0);

  for (let i = period - 1; i < n; i++) {
    let tpSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      tpSum += (candles[j].high + candles[j].low + candles[j].close) / 3;
    }
    const tpSma = tpSum / period;

    let madSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      madSum += Math.abs(tp - tpSma);
    }
    const mad = madSum / period;

    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    out[i] = mad === 0 ? 0 : (tp - tpSma) / (0.015 * mad);
  }

  return out;
}

export function minimaxSeries(
  values: number[],
  period: number,
  min: number,
  max: number,
): number[] {
  const n = values.length;
  const out: number[] = new Array(n).fill((min + max) / 2);

  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] > hi) hi = values[j];
      if (values[j] < lo) lo = values[j];
    }
    const range = hi - lo;
    out[i] = range === 0 ? (min + max) / 2 : ((max - min) * (values[i] - lo)) / range + min;
  }

  return out;
}

export function ribbonMinSeries(ribbon: number[][], closes: number[]): number[] {
  return closes.map((_, i) => {
    let min = Number.POSITIVE_INFINITY;
    for (let j = 0; j < ribbon.length; j++) {
      const v = ribbon[j][i];
      if (v < min) min = v;
    }
    return min === Number.POSITIVE_INFINITY ? closes[i] : min;
  });
}
