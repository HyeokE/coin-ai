import { Position, RiskLimits, TradeResult, TradeSide, DailyStats, AgentDecision } from '../types';

export class RiskManager {
  private dailyStats: DailyStats;
  private tradeHistory: TradeResult[] = [];
  private initialEquity = 0;
  private peakEquity = 0;

  public constructor(private readonly limits: RiskLimits) {
    this.dailyStats = this.createEmptyStats();
  }

  public setInitialEquity(equity: number): void {
    this.initialEquity = equity;
    this.peakEquity = equity;
  }

  public updateEquity(currentEquity: number): void {
    if (currentEquity > this.peakEquity) {
      this.peakEquity = currentEquity;
    }
  }

  public canOpenPosition(
    decision: AgentDecision,
    balance: number,
  ): { allowed: boolean; reason?: string } {
    if (this.isDailyLossLimitReached(balance)) {
      return { allowed: false, reason: 'Daily loss limit reached' };
    }

    if (this.isDailyTradeLimitReached()) {
      return { allowed: false, reason: 'Daily trade limit reached' };
    }

    if (decision.confidence < 60) {
      return { allowed: false, reason: `Low confidence: ${decision.confidence}%` };
    }

    const positionValue = balance * this.limits.maxPositionSizeRatio;
    if (positionValue <= 0) {
      return { allowed: false, reason: 'Insufficient balance' };
    }

    return { allowed: true };
  }

  public checkPositionRisk(
    position: Position,
    currentPrice: number,
  ): { action: 'HOLD' | 'CLOSE'; reason?: string } {
    const pnlRatio = this.calculatePnlRatio(position, currentPrice);

    if (pnlRatio <= -this.limits.stopLossRatio) {
      return { action: 'CLOSE', reason: 'STOP_LOSS' };
    }

    if (pnlRatio >= this.limits.takeProfitRatio) {
      return { action: 'CLOSE', reason: 'TAKE_PROFIT' };
    }

    if (this.isDrawdownExceeded()) {
      return { action: 'CLOSE', reason: 'DRAWDOWN_LIMIT' };
    }

    return { action: 'HOLD' };
  }

  public calculatePositionSize(balance: number, price: number): number {
    const maxValue = balance * this.limits.maxPositionSizeRatio;
    return maxValue / price;
  }

  public calculateStopLoss(entryPrice: number, side: TradeSide): number {
    return side === TradeSide.LONG
      ? entryPrice * (1 - this.limits.stopLossRatio)
      : entryPrice * (1 + this.limits.stopLossRatio);
  }

  public calculateTakeProfit(entryPrice: number, side: TradeSide): number {
    return side === TradeSide.LONG
      ? entryPrice * (1 + this.limits.takeProfitRatio)
      : entryPrice * (1 - this.limits.takeProfitRatio);
  }

  public recordTrade(result: TradeResult): void {
    this.tradeHistory.push(result);
    this.dailyStats.trades++;

    if (result.pnl !== undefined) {
      this.dailyStats.totalPnl += result.pnl;
      if (result.pnl > 0) this.dailyStats.wins++;
      else this.dailyStats.losses++;

      this.updateMaxDrawdown();
    }
  }

  public getDailyStats(): DailyStats {
    return { ...this.dailyStats };
  }

  public resetDailyStats(): void {
    this.dailyStats = this.createEmptyStats();
    this.peakEquity = this.initialEquity;
  }

  public getMaxDailyLossKrw(): number {
    return this.initialEquity * this.limits.maxDailyLossRatio;
  }

  private calculatePnlRatio(position: Position, currentPrice: number): number {
    const direction = position.side === TradeSide.LONG ? 1 : -1;
    return ((currentPrice - position.entryPrice) / position.entryPrice) * direction;
  }

  private isDailyLossLimitReached(currentEquity: number): boolean {
    if (this.initialEquity === 0) return false;
    const lossRatio = (this.initialEquity - currentEquity) / this.initialEquity;
    return lossRatio >= this.limits.maxDailyLossRatio;
  }

  private isDailyTradeLimitReached(): boolean {
    return this.dailyStats.trades >= this.limits.maxDailyTrades;
  }

  private isDrawdownExceeded(): boolean {
    if (this.peakEquity === 0) return false;
    const drawdownRatio = this.dailyStats.maxDrawdown / this.peakEquity;
    return drawdownRatio >= this.limits.maxDrawdownRatio;
  }

  private updateMaxDrawdown(): void {
    const currentDrawdown = this.peakEquity - this.initialEquity + this.dailyStats.totalPnl;
    if (currentDrawdown < 0 && Math.abs(currentDrawdown) > this.dailyStats.maxDrawdown) {
      this.dailyStats.maxDrawdown = Math.abs(currentDrawdown);
    }
  }

  private createEmptyStats(): DailyStats {
    return {
      date: new Date().toISOString().split('T')[0],
      trades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      maxDrawdown: 0,
    };
  }
}
