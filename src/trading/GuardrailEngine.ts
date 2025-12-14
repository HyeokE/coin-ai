export type GuardrailDecision = { allow: true } | { allow: false; reason: string };

export interface GuardrailState {
  dayKey: string;
  dailyRealizedR: number;
  dailyRealizedPct: number;
  tradesToday: number;
  consecutiveSL: number;
  cooldownUntilMs: number;
}

export interface PreTradeContext {
  nowMs: number;
  symbol: string;
  stopPct: number;
  feeInR: number;
  spreadPct?: number;
  topBookKrw?: number;
  volume24hKrw?: number;
  lastCandleTs: number;
  tfMinutes: number;
}

export type ExitReason = 'TAKE_PROFIT' | 'STOP_LOSS' | 'END' | 'SIGNAL';

export interface ClosedTrade {
  r: number;
  pnlPct: number;
  exitReason: ExitReason;
}

export class GuardrailEngine {
  private state: GuardrailState;

  public constructor() {
    this.state = this.createFreshState();
  }

  private createFreshState(): GuardrailState {
    return {
      dayKey: this.getTodayKey(),
      dailyRealizedR: 0,
      dailyRealizedPct: 0,
      tradesToday: 0,
      consecutiveSL: 0,
      cooldownUntilMs: 0,
    };
  }

  private getTodayKey(): string {
    const now = new Date();
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstDate = new Date(now.getTime() + kstOffset);
    return kstDate.toISOString().slice(0, 10);
  }

  private ensureDayReset(): void {
    const today = this.getTodayKey();
    if (this.state.dayKey !== today) {
      this.state = this.createFreshState();
    }
  }

  public check(ctx: PreTradeContext): GuardrailDecision {
    this.ensureDayReset();

    const dailyMaxLossR = parseFloat(process.env.DAILY_MAX_LOSS_R || '3');
    const dailyMaxLossPct = parseFloat(process.env.DAILY_MAX_LOSS_PCT || '1.5');
    const maxConsecutiveSL = parseInt(process.env.MAX_CONSECUTIVE_SL || '4', 10);
    const cooldownMinutes = parseInt(process.env.COOLDOWN_MINUTES || '120', 10);
    const maxTradesPerDay = parseInt(process.env.MAX_TRADES_PER_DAY || '10', 10);

    const maxFeeInR = parseFloat(process.env.MAX_FEE_IN_R || '0.15');
    const minStopPct = parseFloat(process.env.MIN_STOP_PCT || '0.5');
    const maxSpreadPct = parseFloat(process.env.MAX_SPREAD_PCT || '0.08');
    const minTopBookKrw = parseFloat(process.env.MIN_TOPBOOK_KRW || '20000000');
    const minVol24hKrw = parseFloat(process.env.MIN_24H_VOLUME_KRW || '30000000000');

    if (this.state.cooldownUntilMs > ctx.nowMs) {
      return { allow: false, reason: `Cooldown until ${new Date(this.state.cooldownUntilMs).toISOString()}` };
    }

    if (this.state.dailyRealizedR <= -dailyMaxLossR) {
      return { allow: false, reason: `Daily loss hit: ${this.state.dailyRealizedR.toFixed(2)}R` };
    }
    if (this.state.dailyRealizedPct <= -dailyMaxLossPct) {
      return { allow: false, reason: `Daily loss hit: ${this.state.dailyRealizedPct.toFixed(2)}%` };
    }

    if (this.state.tradesToday >= maxTradesPerDay) {
      return { allow: false, reason: `Max trades/day hit: ${this.state.tradesToday}` };
    }

    const maxStaleMs = ctx.tfMinutes * 2 * 60_000;
    if (ctx.nowMs - ctx.lastCandleTs > maxStaleMs) {
      return { allow: false, reason: `Stale candles` };
    }

    if (ctx.feeInR > maxFeeInR) {
      return { allow: false, reason: `FeeInR too high: ${ctx.feeInR.toFixed(2)}R` };
    }
    if (ctx.stopPct < minStopPct) {
      return { allow: false, reason: `Stop too tight: ${ctx.stopPct.toFixed(2)}%` };
    }

    if (ctx.spreadPct != null && ctx.spreadPct > maxSpreadPct) {
      return { allow: false, reason: `Spread too wide: ${ctx.spreadPct.toFixed(3)}%` };
    }
    if (ctx.topBookKrw != null && ctx.topBookKrw < minTopBookKrw) {
      return { allow: false, reason: `Shallow orderbook: ${Math.round(ctx.topBookKrw).toLocaleString()} KRW` };
    }
    if (ctx.volume24hKrw != null && ctx.volume24hKrw < minVol24hKrw) {
      return { allow: false, reason: `Low 24h volume` };
    }

    if (this.state.consecutiveSL >= maxConsecutiveSL) {
      const until = ctx.nowMs + cooldownMinutes * 60_000;
      this.state.cooldownUntilMs = until;
      return { allow: false, reason: `Consecutive SL hit -> cooldown` };
    }

    return { allow: true };
  }

  public onTradeClosed(trade: ClosedTrade): void {
    this.ensureDayReset();

    this.state.dailyRealizedR += trade.r;
    this.state.dailyRealizedPct += trade.pnlPct;
    this.state.tradesToday += 1;

    if (trade.exitReason === 'STOP_LOSS') {
      this.state.consecutiveSL += 1;
    } else if (trade.exitReason === 'TAKE_PROFIT') {
      this.state.consecutiveSL = 0;
    }
  }

  public getState(): Readonly<GuardrailState> {
    this.ensureDayReset();
    return { ...this.state };
  }

  public getStats(): string {
    const s = this.getState();
    return [
      `Day: ${s.dayKey}`,
      `Realized: ${s.dailyRealizedR.toFixed(2)}R / ${s.dailyRealizedPct.toFixed(2)}%`,
      `Trades: ${s.tradesToday}`,
      `Consecutive SL: ${s.consecutiveSL}`,
      s.cooldownUntilMs > Date.now() ? `Cooldown: ${new Date(s.cooldownUntilMs).toISOString()}` : '',
    ].filter(Boolean).join(' | ');
  }
}

export const guardrailEngine = new GuardrailEngine();

