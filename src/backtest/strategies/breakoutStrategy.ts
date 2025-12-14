import { Candle } from '../../types';
import { DecisionProvider } from '../BacktestSimulator';
import { evaluateBreakoutEntryAtIndex, BreakoutMode } from '../../strategies/breakoutEntry';

export interface BreakoutStrategyPrecomputed {
  candles: Candle[];
  closes: number[];
  highs: number[];
  lows: number[];
  ema200: number[];
  ribbon: number[][];
  rsi: number[];
  atr: number[];
  feeRate: number;
  rsiMin: number;
  atrMultiplier: number;
  rr: number;
  mode: BreakoutMode;
  retestLookback: number;
  idxMap: Map<number, number>;
}

export function createBreakoutStrategyProvider(pre: BreakoutStrategyPrecomputed): DecisionProvider {
  return (candlesWindow, _signal, position) => {
    if (position) return { shouldTrade: false, confidence: 0, reasoning: 'Already in position' };

    const last = candlesWindow[candlesWindow.length - 1];
    const idx = pre.idxMap.get(last.timestamp);
    if (idx === undefined) {
      return { shouldTrade: false, confidence: 0, reasoning: 'Index map miss' };
    }

    return evaluateBreakoutEntryAtIndex({
      series: {
        candles: pre.candles,
        closes: pre.closes,
        highs: pre.highs,
        lows: pre.lows,
        ema200: pre.ema200,
        ribbon: pre.ribbon,
        rsi: pre.rsi,
        atr: pre.atr,
      },
      config: {
        feeRate: pre.feeRate,
        rsiMin: pre.rsiMin,
        atrMultiplier: pre.atrMultiplier,
        rr: pre.rr,
        mode: pre.mode,
        retestLookback: pre.retestLookback,
      },
      index: idx,
    });
  };
}

