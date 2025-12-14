import { Candle } from '../../types';
import { DecisionProvider, ExitProvider } from '../BacktestSimulator';
import { evaluateKnnRibbonRsiEntryAtIndex } from '../../strategies/knnRibbonRsiEntry';
import { evaluateKnnRibbonRsiExitAtIndex } from '../../strategies/knnRibbonRsiExit';

export interface VideoStrategyPrecomputed {
  candles: Candle[];
  closes: number[];
  lows: number[];
  ema200: number[];
  ribbon: number[][];
  ribbonMin: number[];
  rsi: number[];
  knnBuy: boolean[];
  feeRate: number;
  rsiLower: number;
  rsiUpper: number;
  swingLookback: number;
  rr: number;
  stopBufferPct: number;
  idxMap: Map<number, number>;
  useEma200Filter?: boolean;
  useRibbonEma200Filter?: boolean;
  dipLookback?: number;
  useDipReclaim?: boolean;
  useKnn?: boolean;
}

export function createVideoStrategyProvider(pre: VideoStrategyPrecomputed): DecisionProvider {
  return (candlesWindow, _signal, position) => {
    if (position) return { shouldTrade: false, confidence: 0, reasoning: 'Already in position' };

    const last = candlesWindow[candlesWindow.length - 1];
    const idx = pre.idxMap.get(last.timestamp);
    if (idx === undefined)
      return { shouldTrade: false, confidence: 0, reasoning: 'Index map miss' };

    return evaluateKnnRibbonRsiEntryAtIndex({
      series: {
        candles: pre.candles,
        closes: pre.closes,
        lows: pre.lows,
        ema200: pre.ema200,
        ribbon: pre.ribbon,
        rsi: pre.rsi,
        knnBuyAt: (i) => pre.knnBuy[i] ?? false,
      },
      config: {
        feeRate: pre.feeRate,
        rsiLower: pre.rsiLower,
        swingLookback: pre.swingLookback,
        rr: pre.rr,
        stopBufferPct: pre.stopBufferPct,
        useEma200Filter: pre.useEma200Filter,
        useRibbonEma200Filter: pre.useRibbonEma200Filter,
        dipLookback: pre.dipLookback,
        useDipReclaim: pre.useDipReclaim,
        useKnn: pre.useKnn,
      },
      index: idx,
    });
  };
}

export function createVideoExitProvider(pre: VideoStrategyPrecomputed): ExitProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (candlesWindow, _position) => {
    const last = candlesWindow[candlesWindow.length - 1];
    const idx = pre.idxMap.get(last.timestamp);
    if (idx === undefined) return { shouldExit: false, reasoning: 'Index map miss' };

    const ex = evaluateKnnRibbonRsiExitAtIndex({
      series: {
        candles: pre.candles,
        closes: pre.closes,
        ema200: pre.ema200,
        ribbonMin: pre.ribbonMin,
        knnBuyAt: (i) => pre.knnBuy[i] ?? false,
      },
      config: {
        ribbonBelowBars: 2,
        knnOffBars: 4,
        exitOnEma200Break: true,
      },
      index: idx,
    });

    return { shouldExit: ex.shouldExit, reasoning: ex.reasoning };
  };
}
