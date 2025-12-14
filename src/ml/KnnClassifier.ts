import { Candle } from '../types';
import { rsiSeries, atrSeries, rocSeries, cciSeries, minimaxSeries } from '../indicators';

export interface KnnTradingViewParams {
  candles: Candle[];
  shortWindow: number;
  longWindow: number;
  baseK: number;
  trainWindow: number;
  volatilityFilter: boolean;
  labelThreshold: number;
  labelHorizon?: number;
  stopBufferPct?: number;
  rr?: number;
  swingLookback?: number;
}

export interface KnnResult {
  signal: number[];
  prediction: number[];
}

function computeTpSlLabel(
  candles: Candle[],
  entryIdx: number,
  horizon: number,
  stopBufferPct: number,
  rr: number,
  swingLookback: number,
): number {
  const n = candles.length;
  if (entryIdx + horizon >= n) return 0;

  const entryPrice = candles[entryIdx].close;

  let swingLow = candles[entryIdx].low;
  for (let j = Math.max(0, entryIdx - swingLookback + 1); j <= entryIdx; j++) {
    if (candles[j].low < swingLow) swingLow = candles[j].low;
  }

  const sl = swingLow * (1 - stopBufferPct);
  const risk = entryPrice - sl;
  if (risk <= 0) return 0;

  const tp = entryPrice + rr * risk;

  for (let j = entryIdx + 1; j <= entryIdx + horizon && j < n; j++) {
    const high = candles[j].high;
    const low = candles[j].low;

    if (high >= tp) return 1;
    if (low <= sl) return -1;
  }

  return 0;
}

export function knnTradingViewSeries(params: KnnTradingViewParams): KnnResult {
  const {
    candles,
    shortWindow,
    longWindow,
    baseK,
    trainWindow,
    volatilityFilter,
    labelThreshold,
    labelHorizon = 30,
    stopBufferPct = 0.002,
    rr = 1.5,
    swingLookback = 8,
  } = params;

  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const k = Math.floor(Math.sqrt(baseK));

  const rsLong = rsiSeries(closes, longWindow);
  const rsShort = rsiSeries(closes, shortWindow);
  const cciLong = cciSeries(candles, longWindow);
  const cciShort = cciSeries(candles, shortWindow);
  const rocLong = rocSeries(closes, longWindow);
  const rocShort = rocSeries(closes, shortWindow);
  const volLong = minimaxSeries(volumes, longWindow, 0, 99);
  const volShort = minimaxSeries(volumes, shortWindow, 0, 99);

  const atr10 = atrSeries(candles, 10);
  const atr40 = atrSeries(candles, 40);

  const feature1: number[] = new Array(n);
  const feature2: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    feature1[i] = (rsLong[i] + cciLong[i] + rocLong[i] + volLong[i]) / 4;
    feature2[i] = (rsShort[i] + cciShort[i] + rocShort[i] + volShort[i]) / 4;
  }

  const useTpSlLabel = labelHorizon > 1;

  const signal: number[] = new Array(n).fill(0);
  const prediction: number[] = new Array(n).fill(0);

  const warmup = Math.max(longWindow, trainWindow) + 10;

  for (let i = warmup; i < n; i++) {
    const f1 = feature1[i];
    const f2 = feature2[i];

    const neighbors: { d: number; dir: number }[] = [];

    const start = Math.max(0, i - trainWindow);
    for (let t = start; t < i - 1; t++) {
      const d = Math.sqrt(Math.pow(f1 - feature1[t], 2) + Math.pow(f2 - feature2[t], 2));

      let dir: number;
      if (useTpSlLabel) {
        dir = computeTpSlLabel(candles, t, labelHorizon, stopBufferPct, rr, swingLookback);
      } else {
        const futureRet = (closes[t + 1] - closes[t]) / closes[t];
        if (futureRet > labelThreshold) {
          dir = 1;
        } else if (futureRet < -labelThreshold) {
          dir = -1;
        } else {
          dir = 0;
        }
      }

      neighbors.push({ d, dir });
    }

    neighbors.sort((a, b) => a.d - b.d);
    const topK = neighbors.slice(0, k);

    const pred = topK.reduce((sum, nb) => sum + nb.dir, 0);
    prediction[i] = pred;

    const filter = volatilityFilter ? atr10[i] > atr40[i] : true;

    if (pred > 0 && filter) {
      signal[i] = 1;
    } else if (pred < 0 && filter) {
      signal[i] = -1;
    } else {
      signal[i] = 0;
    }
  }

  return { signal, prediction };
}

export function knnTradingViewAtIndex(params: KnnTradingViewParams & { index: number }): {
  signal: number;
  prediction: number;
} {
  const {
    candles,
    shortWindow,
    longWindow,
    baseK,
    trainWindow,
    volatilityFilter,
    labelThreshold,
    index,
  } = params;

  const n = candles.length;
  if (index <= 0 || index >= n) return { signal: 0, prediction: 0 };

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const k = Math.floor(Math.sqrt(baseK));

  const rsLong = rsiSeries(closes, longWindow);
  const rsShort = rsiSeries(closes, shortWindow);
  const cciLong = cciSeries(candles, longWindow);
  const cciShort = cciSeries(candles, shortWindow);
  const rocLong = rocSeries(closes, longWindow);
  const rocShort = rocSeries(closes, shortWindow);
  const volLong = minimaxSeries(volumes, longWindow, 0, 99);
  const volShort = minimaxSeries(volumes, shortWindow, 0, 99);

  const atr10 = atrSeries(candles, 10);
  const atr40 = atrSeries(candles, 40);

  const feature1: number[] = new Array(n);
  const feature2: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    feature1[i] = (rsLong[i] + cciLong[i] + rocLong[i] + volLong[i]) / 4;
    feature2[i] = (rsShort[i] + cciShort[i] + rocShort[i] + volShort[i]) / 4;
  }

  const warmup = Math.max(longWindow, trainWindow) + 10;
  if (index < warmup) return { signal: 0, prediction: 0 };

  const f1 = feature1[index];
  const f2 = feature2[index];

  const neighbors: { d: number; dir: number }[] = [];
  const start = Math.max(0, index - trainWindow);
  for (let t = start; t < index - 1; t++) {
    const d = Math.sqrt(Math.pow(f1 - feature1[t], 2) + Math.pow(f2 - feature2[t], 2));

    const futureRet = (closes[t + 1] - closes[t]) / closes[t];
    let dir: number;
    if (futureRet > labelThreshold) {
      dir = 1;
    } else if (futureRet < -labelThreshold) {
      dir = -1;
    } else {
      dir = 0;
    }

    neighbors.push({ d, dir });
  }

  neighbors.sort((a, b) => a.d - b.d);
  const topK = neighbors.slice(0, k);

  const prediction = topK.reduce((sum, nb) => sum + nb.dir, 0);
  const filter = volatilityFilter ? atr10[index] > atr40[index] : true;

  const signal = prediction > 0 && filter ? 1 : prediction < 0 && filter ? -1 : 0;
  return { signal, prediction };
}

export interface KnnBuySeriesParams {
  candles: Candle[];
  closes: number[];
  ema200: number[];
  ribbonMin: number[];
  shortWindow: number;
  longWindow: number;
  baseK: number;
  trainWindow: number;
  labelThreshold: number;
  volatilityFilter: boolean;
}

export interface KnnBuySeriesExtParams extends KnnBuySeriesParams {
  labelHorizon?: number;
  stopBufferPct?: number;
  rr?: number;
  swingLookback?: number;
}

export function knnBuySeries(params: KnnBuySeriesExtParams): boolean[] {
  const {
    candles,
    closes,
    shortWindow,
    longWindow,
    baseK,
    trainWindow,
    labelThreshold,
    volatilityFilter,
    labelHorizon = 30,
    stopBufferPct = 0.002,
    rr = 1.5,
    swingLookback = 8,
  } = params;

  const n = closes.length;

  const { prediction } = knnTradingViewSeries({
    candles,
    shortWindow,
    longWindow,
    baseK,
    trainWindow,
    volatilityFilter,
    labelThreshold,
    labelHorizon,
    stopBufferPct,
    rr,
    swingLookback,
  });

  const out: boolean[] = new Array(n).fill(false);

  for (let i = 0; i < n; i++) {
    out[i] = prediction[i] > 0;
  }

  return out;
}

export function knnBuyAtIndex(params: KnnBuySeriesExtParams & { index: number }): boolean {
  const {
    candles,
    closes,
    shortWindow,
    longWindow,
    baseK,
    trainWindow,
    labelThreshold,
    volatilityFilter,
    index,
    labelHorizon = 30,
    stopBufferPct = 0.002,
    rr = 1.5,
    swingLookback = 8,
  } = params;

  if (index < 0 || index >= closes.length) return false;

  const { prediction } = knnTradingViewSeries({
    candles,
    shortWindow,
    longWindow,
    baseK,
    trainWindow,
    volatilityFilter,
    labelThreshold,
    labelHorizon,
    stopBufferPct,
    rr,
    swingLookback,
  });

  return prediction[index] > 0;
}
