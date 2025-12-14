import { Candle } from '../types';

type Series = {
  candles: Candle[];
  closes: number[];
  ema200: number[];
  ribbonMin: number[];
  knnBuyAt: (i: number) => boolean;
};

type Config = {
  ribbonBelowBars: number;
  knnOffBars: number;
  exitOnEma200Break: boolean;
};

function streak(fn: (j: number) => boolean, i: number, n: number): boolean {
  for (let k = 0; k < n; k++) {
    const j = i - k;
    if (j < 0) return false;
    if (!fn(j)) return false;
  }
  return true;
}

export function evaluateKnnRibbonRsiExitAtIndex(args: {
  series: Series;
  config: Config;
  index: number;
}): { shouldExit: boolean; reasoning: string } {
  const { series, config, index: i } = args;

  const close = series.closes[i];

  if (config.exitOnEma200Break && close < series.ema200[i]) {
    return { shouldExit: true, reasoning: 'Close < EMA200' };
  }

  const belowRibbon = streak(
    (j) => series.closes[j] < series.ribbonMin[j],
    i,
    config.ribbonBelowBars,
  );
  const knnOff = streak((j) => !series.knnBuyAt(j), i, config.knnOffBars);

  if (belowRibbon && knnOff) {
    return {
      shouldExit: true,
      reasoning: `BelowRibbon(${config.ribbonBelowBars}) & KNNOff(${config.knnOffBars})`,
    };
  }

  return { shouldExit: false, reasoning: 'Hold' };
}
