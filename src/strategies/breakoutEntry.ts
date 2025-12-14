import { AgentDecision, Candle, TradeSide } from '../types';

export type BreakoutMode = 'immediate' | 'confirmed' | 'retest';

export interface BreakoutEntryConfig {
  feeRate: number;
  rsiMin: number;
  atrMultiplier: number;
  rr: number;
  mode: BreakoutMode;
  retestLookback: number;
}

export interface BreakoutSeries {
  candles: Candle[];
  closes: number[];
  highs: number[];
  lows: number[];
  ema200: number[];
  ribbon: number[][];
  rsi: number[];
  atr: number[];
}

function getRibbonValues(ribbon: number[][], index: number) {
  const vals = ribbon.map((r) => r[index]);
  return {
    max: Math.max(...vals),
    min: Math.min(...vals),
    mid: (Math.max(...vals) + Math.min(...vals)) / 2,
  };
}

function isRibbonAligned(ribbon: number[][], index: number, lookback: number = 3): boolean {
  if (index < lookback) return false;

  for (const ema of ribbon) {
    const slope = ema[index] - ema[index - lookback];
    if (slope <= 0) return false;
  }

  const vals = ribbon.map((r) => r[index]);
  for (let i = 0; i < vals.length - 1; i++) {
    if (vals[i] < vals[i + 1]) return false;
  }

  return true;
}

function detectBreakoutBar(series: BreakoutSeries, index: number): number {
  const { ribbon } = series;
  for (let j = index; j >= Math.max(1, index - 10); j--) {
    const { max: ribbonMax } = getRibbonValues(ribbon, j);
    const prevClose = series.closes[j - 1];
    const curClose = series.closes[j];
    if (prevClose <= ribbonMax && curClose > ribbonMax) {
      return j;
    }
  }
  return -1;
}

export function evaluateBreakoutEntryAtIndex(params: {
  series: BreakoutSeries;
  config: BreakoutEntryConfig;
  index: number;
}): AgentDecision {
  const { series, config, index } = params;

  if (index < 5 || index >= series.closes.length) {
    return { shouldTrade: false, confidence: 0, reasoning: 'Index out of range' };
  }

  const price = series.closes[index];
  const ema200 = series.ema200[index];

  if (!(price > ema200)) {
    return { shouldTrade: false, confidence: 0, reasoning: 'Close <= EMA200' };
  }

  if (!isRibbonAligned(series.ribbon, index)) {
    return { shouldTrade: false, confidence: 0, reasoning: 'Ribbon not aligned' };
  }

  const { max: ribbonMax } = getRibbonValues(series.ribbon, index);

  const rsi = series.rsi[index];
  if (rsi < config.rsiMin) {
    return { shouldTrade: false, confidence: 0, reasoning: `RSI < ${config.rsiMin} (${rsi.toFixed(1)})` };
  }

  const atr = series.atr[index];
  if (!atr || atr <= 0) {
    return { shouldTrade: false, confidence: 0, reasoning: 'ATR invalid' };
  }

  if (config.mode === 'immediate') {
    const prevClose = series.closes[index - 1];
    if (!(prevClose <= ribbonMax && price > ribbonMax)) {
      return { shouldTrade: false, confidence: 0, reasoning: 'No ribbon breakout' };
    }
  } else if (config.mode === 'confirmed') {
    const breakoutBar = detectBreakoutBar(series, index - 1);
    if (breakoutBar === -1 || breakoutBar !== index - 1) {
      return { shouldTrade: false, confidence: 0, reasoning: 'No breakout yesterday' };
    }
    const { max: prevRibbonMax } = getRibbonValues(series.ribbon, index - 1);
    if (!(price > prevRibbonMax)) {
      return { shouldTrade: false, confidence: 0, reasoning: 'Confirm bar below ribbon' };
    }
  } else if (config.mode === 'retest') {
    const breakoutBar = detectBreakoutBar(series, index - 1);
    if (breakoutBar === -1) {
      return { shouldTrade: false, confidence: 0, reasoning: 'No prior breakout' };
    }
    const barsSinceBreakout = index - breakoutBar;
    if (barsSinceBreakout < 1 || barsSinceBreakout > config.retestLookback) {
      return { shouldTrade: false, confidence: 0, reasoning: 'Retest window miss' };
    }

    let touchedRibbon = false;
    for (let j = breakoutBar + 1; j < index; j++) {
      const { max: jMax } = getRibbonValues(series.ribbon, j);
      if (series.lows[j] <= jMax * 1.002) {
        touchedRibbon = true;
        break;
      }
    }
    if (!touchedRibbon) {
      return { shouldTrade: false, confidence: 0, reasoning: 'No retest touch' };
    }

    if (!(price > ribbonMax)) {
      return { shouldTrade: false, confidence: 0, reasoning: 'Retest bar not above ribbon' };
    }
  }

  const stopLoss = price - config.atrMultiplier * atr;
  const risk = price - stopLoss;

  if (risk <= 0 || risk < price * 0.002) {
    return { shouldTrade: false, confidence: 0, reasoning: 'Risk too small' };
  }

  let targetPrice = price + config.rr * risk;

  const minNetMove = config.feeRate * 2 * 2;
  const minTarget = price * (1 + minNetMove);
  if (targetPrice < minTarget) targetPrice = minTarget;

  let confidence = 100;

  const modeLabel = config.mode === 'immediate' ? 'Breakout' : config.mode === 'confirmed' ? 'Confirmed' : 'Retest';

  return {
    shouldTrade: true,
    side: TradeSide.LONG,
    confidence,
    entryPrice: price,
    stopLoss,
    targetPrice,
    reasoning: `${modeLabel} + RSI momentum`,
  };
}

