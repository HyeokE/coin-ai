import { Candle, VolatilitySignal, BotConfig } from '../types';

export class VolatilityTrigger {
  private atrHistory: number[] = [];

  public constructor(private readonly config: BotConfig) {}

  public analyze(candles: Candle[]): VolatilitySignal | null {
    if (candles.length < 20) return null;

    const candidates: Array<{ strength: number; signal: VolatilitySignal }> = [];

    const atr = this.checkATRSpikeCandidate(candles);
    if (atr) candidates.push(atr);

    const surge = this.checkPriceSurgeCandidate(candles);
    if (surge) candidates.push(surge);

    const volume = this.checkVolumeSpikeCandidate(candles);
    if (volume) candidates.push(volume);

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.strength - a.strength);
    return candidates[0].signal;
  }

  private checkATRSpikeCandidate(
    candles: Candle[],
  ): { strength: number; signal: VolatilitySignal } | null {
    const atr = this.calculateATR(candles, 14);
    const avgATR = this.getAverageATR();
    const currentPrice = candles[candles.length - 1].close;
    const atrPercent = currentPrice > 0 ? atr / currentPrice : 0;

    this.atrHistory.push(atr);
    if (this.atrHistory.length > 50) this.atrHistory.shift();

    if (avgATR === 0) return null;

    const threshold = avgATR * (1 + this.config.volatilityThresholds.atrMultiplier);
    if (atr <= threshold) return null;

    return {
      strength: atr / threshold,
      signal: {
        type: 'ATR_SPIKE',
        value: atr,
        threshold,
        direction: this.detectDirection(candles),
        timestamp: Date.now(),
        atrPercent,
      },
    };
  }

  private checkPriceSurgeCandidate(
    candles: Candle[],
  ): { strength: number; signal: VolatilitySignal } | null {
    const recent = candles.slice(-5);
    const startPrice = recent[0].open;
    const endPrice = recent[recent.length - 1].close;
    const changePct = (endPrice - startPrice) / startPrice;
    const threshold = this.config.volatilityThresholds.priceSurgePct;

    if (Math.abs(changePct) <= threshold) return null;

    const atr = this.calculateATR(candles, 14);
    const atrPercent = endPrice > 0 ? atr / endPrice : 0;

    return {
      strength: Math.abs(changePct) / threshold,
      signal: {
        type: 'PRICE_SURGE',
        value: Math.abs(changePct) * 100,
        threshold: threshold * 100,
        direction: changePct > 0 ? 'UP' : 'DOWN',
        timestamp: Date.now(),
        atrPercent,
      },
    };
  }

  private checkVolumeSpikeCandidate(
    candles: Candle[],
  ): { strength: number; signal: VolatilitySignal } | null {
    const recent = candles.slice(-20);
    const avgVolume =
      recent.slice(0, -1).reduce((sum, c) => sum + c.volume, 0) / (recent.length - 1);
    const currentVolume = recent[recent.length - 1].volume;
    const threshold = avgVolume * this.config.volatilityThresholds.volumeSpikeMultiplier;

    if (currentVolume <= threshold) return null;

    const currentPrice = candles[candles.length - 1].close;
    const atr = this.calculateATR(candles, 14);
    const atrPercent = currentPrice > 0 ? atr / currentPrice : 0;

    return {
      strength: currentVolume / threshold,
      signal: {
        type: 'VOLUME_SPIKE',
        value: currentVolume / avgVolume,
        threshold: this.config.volatilityThresholds.volumeSpikeMultiplier,
        direction: this.detectDirection(candles),
        timestamp: Date.now(),
        atrPercent,
      },
    };
  }

  private calculateATR(candles: Candle[], period: number): number {
    if (candles.length < period + 1) return 0;

    const trueRanges: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;

      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);
    }

    const recentTR = trueRanges.slice(-period);
    return recentTR.reduce((sum, tr) => sum + tr, 0) / period;
  }

  private getAverageATR(): number {
    if (this.atrHistory.length === 0) return 0;
    return this.atrHistory.reduce((sum, a) => sum + a, 0) / this.atrHistory.length;
  }

  private detectDirection(candles: Candle[]): 'UP' | 'DOWN' | 'NEUTRAL' {
    const recent = candles.slice(-3);
    const change = recent[recent.length - 1].close - recent[0].open;
    if (change > 0) return 'UP';
    if (change < 0) return 'DOWN';
    return 'NEUTRAL';
  }
}
