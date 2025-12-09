import { Candle, MarketData, TradeSide, VolatilitySignal, AgentDecision, Position } from '../types';
import { OrderPlanner, RiskPolicy, PortfolioState, OrderPlan } from '../planner/OrderPlanner';
import { getRiskScaleForSymbol, getVolatilityBasedSlTp } from '../config/config';
import {
  VolatilityThresholds,
  detectVolatilitySignal,
  checkPositionExit,
  calculatePnl,
} from '../trading/TradingCore';

export interface BacktestConfig {
  symbol: string;
  initialCapitalKrw: number;
  riskPolicy: RiskPolicy;
  volatilityThresholds: VolatilityThresholds;
}

export interface SimulatedPosition extends Position {
  entryIndex: number;
  stopLoss?: number;
  targetPrice?: number;
}

export interface BacktestTrade {
  entryIndex: number;
  exitIndex: number;
  side: TradeSide;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPercent: number;
  exitReason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'SIGNAL' | 'END';
}

export interface DebugStats {
  noSignal: number;
  agentSkip: number;
  plannerReject: number;
  executed: number;
}

export interface BacktestResult {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  totalPnlPercent: number;
  maxDrawdown: number;
  sharpeRatio: number;
  trades: BacktestTrade[];
  equityCurve: number[];
  signalsDetected: number;
  debugStats: DebugStats;
}

export type DecisionProvider = (
  candles: Candle[],
  signal: VolatilitySignal,
  position: SimulatedPosition | null,
) => AgentDecision;

export class BacktestSimulator {
  private readonly planner: OrderPlanner;
  private position: SimulatedPosition | null = null;
  private cashKrw: number;
  private trades: BacktestTrade[] = [];
  private equityCurve: number[] = [];
  private peakEquity: number;
  private maxDrawdown = 0;
  private realizedPnlToday = 0;
  private signalCount = 0;
  private debugStats: DebugStats = { noSignal: 0, agentSkip: 0, plannerReject: 0, executed: 0 };

  public constructor(private readonly config: BacktestConfig) {
    this.planner = new OrderPlanner(config.riskPolicy);
    this.cashKrw = config.initialCapitalKrw;
    this.peakEquity = config.initialCapitalKrw;
  }

  public run(candles: Candle[], decisionProvider: DecisionProvider): BacktestResult {
    this.reset();

    for (let i = 30; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const current = candles[i];
      const price = current.close;

      this.updateEquity(price);
      this.checkAndClosePosition(i, price);

      if (this.position) continue;

      const signal = detectVolatilitySignal(slice, this.config.volatilityThresholds);
      if (!signal) {
        this.debugStats.noSignal++;
        continue;
      }

      this.signalCount++;
      const decision = decisionProvider(slice, signal, this.position);
      if (!decision.shouldTrade || !decision.side) {
        this.debugStats.agentSkip++;
        continue;
      }

      const portfolio = this.buildPortfolio(price);
      const marketData = this.buildMarketData(slice, price);

      const volatilityRatio = signal.atrPercent ?? 0.03;
      const riskScale = getRiskScaleForSymbol(this.config.symbol);
      const customSlTp = getVolatilityBasedSlTp(this.config.symbol, volatilityRatio);

      const plan = this.planner.planOrder({
        decision,
        marketData,
        portfolio,
        volatility: signal,
        riskScale,
        customSlTp,
      });

      if (!plan.shouldExecute || !plan.quantity || !plan.side) {
        this.debugStats.plannerReject++;
        continue;
      }

      this.openPosition(i, plan);
      this.debugStats.executed++;
    }

    if (this.position) {
      this.closePosition(candles.length - 1, candles[candles.length - 1].close, 'END');
    }

    return this.buildResult();
  }

  private reset(): void {
    this.position = null;
    this.cashKrw = this.config.initialCapitalKrw;
    this.trades = [];
    this.equityCurve = [];
    this.peakEquity = this.config.initialCapitalKrw;
    this.maxDrawdown = 0;
    this.realizedPnlToday = 0;
    this.signalCount = 0;
    this.debugStats = { noSignal: 0, agentSkip: 0, plannerReject: 0, executed: 0 };
  }

  private updateEquity(price: number): void {
    const positionValue = this.position ? this.position.quantity * price : 0;
    const equity = this.cashKrw + positionValue;
    this.equityCurve.push(equity);

    if (equity > this.peakEquity) {
      this.peakEquity = equity;
    }

    const drawdown = (this.peakEquity - equity) / this.peakEquity;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }
  }

  private checkAndClosePosition(index: number, price: number): void {
    if (!this.position) return;

    const exitResult = checkPositionExit(this.position, price);
    if (exitResult.shouldExit && exitResult.reason) {
      this.closePosition(index, price, exitResult.reason);
    }
  }

  private openPosition(index: number, plan: OrderPlan): void {
    if (!plan.quantity || !plan.side || !plan.entryPrice) return;

    const cost = plan.quantity * plan.entryPrice;
    this.cashKrw -= cost;

    this.position = {
      symbol: this.config.symbol,
      side: plan.side,
      entryPrice: plan.entryPrice,
      quantity: plan.quantity,
      timestamp: Date.now(),
      unrealizedPnl: 0,
      entryIndex: index,
      stopLoss: plan.stopLoss,
      targetPrice: plan.targetPrice,
    };
  }

  private closePosition(
    index: number,
    exitPrice: number,
    reason: BacktestTrade['exitReason'],
  ): void {
    if (!this.position) return;

    const { entryPrice, quantity, entryIndex, side } = this.position;
    const proceeds = quantity * exitPrice;
    this.cashKrw += proceeds;

    const { pnl, pnlPercent } = calculatePnl(this.position, exitPrice);
    this.realizedPnlToday += pnlPercent / 100;

    this.trades.push({
      entryIndex,
      exitIndex: index,
      side,
      entryPrice,
      exitPrice,
      quantity,
      pnl,
      pnlPercent,
      exitReason: reason,
    });

    this.position = null;
  }

  private buildPortfolio(price: number): PortfolioState {
    const positionValue = this.position ? this.position.quantity * price : 0;
    return {
      totalEquityKrw: this.cashKrw + positionValue,
      cashKrw: this.cashKrw,
      positions: this.position
        ? [
            {
              symbol: this.position.symbol,
              side: this.position.side,
              entryPrice: this.position.entryPrice,
              quantity: this.position.quantity,
              timestamp: Date.now(),
              unrealizedPnl: 0,
            },
          ]
        : [],
      realizedPnlTodayPct: this.realizedPnlToday,
    };
  }

  private buildMarketData(candles: Candle[], price: number): MarketData {
    return {
      symbol: this.config.symbol,
      price,
      timestamp: Date.now(),
      candles,
    };
  }

  private buildResult(): BacktestResult {
    const winningTrades = this.trades.filter((t) => t.pnl > 0);
    const losingTrades = this.trades.filter((t) => t.pnl <= 0);
    const totalPnl = this.trades.reduce((sum, t) => sum + t.pnl, 0);
    const totalPnlPercent = (totalPnl / this.config.initialCapitalKrw) * 100;

    const returns = this.calcReturns();
    const sharpeRatio = this.calcSharpe(returns);

    return {
      totalTrades: this.trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: this.trades.length > 0 ? (winningTrades.length / this.trades.length) * 100 : 0,
      totalPnl,
      totalPnlPercent,
      maxDrawdown: this.maxDrawdown * 100,
      sharpeRatio,
      trades: this.trades,
      equityCurve: this.equityCurve,
      signalsDetected: this.signalCount,
      debugStats: this.debugStats,
    };
  }

  private calcReturns(): number[] {
    const returns: number[] = [];
    for (let i = 1; i < this.equityCurve.length; i++) {
      returns.push((this.equityCurve[i] - this.equityCurve[i - 1]) / this.equityCurve[i - 1]);
    }
    return returns;
  }

  private calcSharpe(returns: number[]): number {
    if (returns.length === 0) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    return (mean / std) * Math.sqrt(252);
  }
}
