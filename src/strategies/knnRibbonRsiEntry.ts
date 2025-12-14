import { AgentDecision, Candle, TradeSide } from '../types';

export interface KnnRibbonRsiEntryConfig {
  feeRate: number;
  rsiLower: number;
  swingLookback: number;
  rr: number;
  stopBufferPct: number;
  useEma200Filter?: boolean;
  useRibbonEma200Filter?: boolean;
  dipLookback?: number;
  useDipReclaim?: boolean;
  useKnn?: boolean;
}

export interface KnnRibbonRsiSeries {
  candles: Candle[];
  closes: number[];
  lows: number[];
  ema200: number[];
  ribbon: number[][];
  rsi: number[];
  knnBuyAt: (index: number) => boolean;
}

export function evaluateKnnRibbonRsiEntryAtIndex(params: {
  series: KnnRibbonRsiSeries;
  config: KnnRibbonRsiEntryConfig;
  index: number;
}): AgentDecision {
  const { series, config, index } = params;

  if (index < 0 || index >= series.closes.length) {
    return { shouldTrade: false, confidence: 0, reasoning: 'Index out of range' };
  }

  const price = series.closes[index];
  const ema200 = series.ema200[index];

  const useEma200Filter = config.useEma200Filter ?? true;
  const useRibbonEma200Filter = config.useRibbonEma200Filter ?? true;
  const dipLookback = config.dipLookback ?? 3;
  const useDipReclaim = config.useDipReclaim ?? true;
  const useKnn = config.useKnn ?? true;

  if (useEma200Filter && !(price > ema200)) {
    return { shouldTrade: false, confidence: 0, reasoning: 'Close <= EMA200' };
  }

  const ribbonVals = series.ribbon.map((arr) => arr[index]);
  const ribbonMin = Math.min(...ribbonVals);
  const ribbonMax = Math.max(...ribbonVals);

  if (useRibbonEma200Filter && !(ribbonMin > ema200)) {
    return { shouldTrade: false, confidence: 0, reasoning: 'Ribbon <= EMA200' };
  }

  if (useDipReclaim) {
    let dipped = false;
    for (let j = Math.max(0, index - dipLookback + 1); j <= index; j++) {
      if (series.lows[j] < ribbonMin) {
        dipped = true;
        break;
      }
    }

    const backInside = price >= ribbonMin && price <= ribbonMax;
    if (!(dipped && backInside)) {
      return { shouldTrade: false, confidence: 0, reasoning: 'No dip-reclaim' };
    }
  }

  if (useKnn && !series.knnBuyAt(index)) {
    return { shouldTrade: false, confidence: 0, reasoning: 'KNN not BUY' };
  }

  const rsi = series.rsi[index];
  const prevRsi = index >= 1 ? series.rsi[index - 1] : rsi;
  const rsiBuy =
    (prevRsi < config.rsiLower && rsi >= config.rsiLower) ||
    (rsi <= config.rsiLower + 5 && rsi > prevRsi);

  if (!rsiBuy)
    return { shouldTrade: false, confidence: 0, reasoning: `RSI not buy (${rsi.toFixed(1)})` };

  const lb = Math.min(config.swingLookback, index);
  let swingLow = series.lows[index];
  for (let j = index - lb + 1; j <= index; j++) {
    if (series.lows[j] < swingLow) swingLow = series.lows[j];
  }

  const stopLoss = swingLow * (1 - config.stopBufferPct);
  if (!(stopLoss < price * 0.999))
    return { shouldTrade: false, confidence: 0, reasoning: 'Stop too tight' };

  const risk = price - stopLoss;
  let targetPrice = price + config.rr * risk;

  const minNetMove = config.feeRate * 2 * 2;
  const minTarget = price * (1 + minNetMove);
  if (targetPrice < minTarget) targetPrice = minTarget;

  let confidence = 55;
  if (rsi <= config.rsiLower + 2) confidence += 10;
  if (price - ribbonMin < risk * 0.5) confidence += 5;
  confidence = Math.max(0, Math.min(90, confidence));

  return {
    shouldTrade: true,
    side: TradeSide.LONG,
    confidence,
    entryPrice: price,
    stopLoss,
    targetPrice,
    reasoning: 'KNN+EMA ribbon+RSI(60/40) AND',
  };
}
