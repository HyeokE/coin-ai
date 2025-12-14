import { getRiskScaleForSymbol, getVolatilityBasedSlTp } from '../config/config';
import { OrderPlan, OrderPlanner, PortfolioState, RiskPolicy } from '../planner/OrderPlanner';
import { VolatilityThresholds, calculateATR, detectVolatilitySignal } from '../trading/TradingCore';
import { AgentDecision, Candle, MarketData, Position, TradeSide, VolatilitySignal } from '../types';

export interface BacktestConfig {
  symbol: string;
  initialCapitalKrw: number;
  riskPolicy: RiskPolicy;
  volatilityThresholds: VolatilityThresholds;
  feeRate: number;
  beTriggerR?: number;
  /**
   * 라이브(TradingBotWS)와 동일하게 "변동성 시그널이 있어야만" 진입 의사결정(AI/전략)을 호출한다.
   * - true(기본): signal 없으면 decisionProvider 호출 자체를 스킵
   * - false: signal이 없어도 decisionProvider에 null signal을 전달하여 매 캔들 평가
   */
  gateOnSignal?: boolean;
  signalExitMinHoldBars?: number;
  signalExitAfterBeOnly?: boolean;
}

export interface SimulatedPosition extends Position {
  entryIndex: number;
  stopLoss?: number;
  targetPrice?: number;
  initialStopLoss?: number;
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
  candlesWindow: Candle[],
  signal: VolatilitySignal | null,
  position: SimulatedPosition | null,
) => AgentDecision;

export type ExitProvider = (
  candlesWindow: Candle[],
  position: SimulatedPosition,
) => { shouldExit: boolean; exitPrice?: number; reasoning?: string };

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

  public run(
    candles: Candle[],
    decisionProvider: DecisionProvider,
    exitProvider?: ExitProvider,
  ): BacktestResult {
    return this.runRange(candles, 0, candles.length, decisionProvider, exitProvider);
  }

  public runRange(
    candles: Candle[],
    startIdx: number,
    endIdxExclusive: number,
    decisionProvider: DecisionProvider,
    exitProvider?: ExitProvider,
  ): BacktestResult {
    this.reset();

    const beTriggerR = this.config.beTriggerR ?? 0.25;
    const gateOnSignal = this.config.gateOnSignal ?? false;
    const WINDOW = 300;

    const start = Math.max(startIdx, 250);
    const end = Math.min(endIdxExclusive, candles.length);

    for (let i = start; i < end; i++) {
      const price = candles[i].close;

      this.updateEquity(price);

      const wStart = Math.max(0, i - WINDOW + 1);
      const candlesWindow = candles.slice(wStart, i + 1);

      if (this.position) {
        const sl0 = this.position.initialStopLoss ?? this.position.stopLoss;
        let beArmed = false;

        if (sl0 && this.position.stopLoss && this.position.stopLoss < this.position.entryPrice) {
          const R = this.position.entryPrice - sl0;
          if (R > 0) {
            const beTrigger = this.position.entryPrice + beTriggerR * R;
            if (price >= beTrigger) {
              this.position.stopLoss = Math.max(this.position.stopLoss, this.position.entryPrice);
              beArmed = true;
            }
          }
        }
        if (this.position.stopLoss && this.position.stopLoss >= this.position.entryPrice) {
          beArmed = true;
        }

        if (this.position.stopLoss && price <= this.position.stopLoss) {
          this.closePosition(i, this.position.stopLoss, 'STOP_LOSS');
          continue;
        }
        if (this.position.targetPrice && price >= this.position.targetPrice) {
          this.closePosition(i, this.position.targetPrice, 'TAKE_PROFIT');
          continue;
        }

        if (exitProvider) {
          const minHold = this.config.signalExitMinHoldBars ?? 2;
          const afterBeOnly = this.config.signalExitAfterBeOnly ?? true;
          const heldBars = i - this.position.entryIndex;

          if (heldBars >= minHold && (!afterBeOnly || beArmed)) {
            const ex = exitProvider(candlesWindow, this.position);
            if (ex.shouldExit) {
              this.closePosition(i, ex.exitPrice ?? price, 'SIGNAL');
              continue;
            }
          }
        }
      }

      if (this.position) continue;

      const signal = detectVolatilitySignal(candlesWindow, this.config.volatilityThresholds);
      if (!signal) {
        this.debugStats.noSignal++;
        if (gateOnSignal) continue; // ✅ live와 동일: signal 없으면 AI/전략 호출 스킵
      } else {
        this.signalCount++;
      }

      // ✅ Run strategy every candle (signal is optional context)
      const decision = decisionProvider(candlesWindow, signal, this.position);
      if (!decision.shouldTrade) {
        this.debugStats.agentSkip++;
        continue;
      }

      const portfolio = this.buildPortfolio(price);
      const marketData: MarketData = {
        symbol: this.config.symbol,
        price,
        timestamp: candles[i].timestamp ?? Date.now(),
        candles: candlesWindow,
      };

      const atr = calculateATR(candlesWindow, 14);
      const volatilityRatio = price > 0 ? atr / price : 0.03;
      const riskScale = getRiskScaleForSymbol(this.config.symbol);
      const customSlTp = getVolatilityBasedSlTp(this.config.symbol, volatilityRatio);

      const plan = this.planner.planOrder({
        decision,
        marketData,
        portfolio,
        volatility: signal ?? undefined,
        riskScale,
        customSlTp,
      });

      if (!plan.shouldExecute || !plan.quantity || !plan.side || !plan.entryPrice) {
        this.debugStats.plannerReject++;
        continue;
      }

      this.openPosition(i, plan);
      this.debugStats.executed++;
    }

    if (this.position) {
      const lastIdx = end - 1;
      this.closePosition(lastIdx, candles[lastIdx].close, 'END');
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

    if (equity > this.peakEquity) this.peakEquity = equity;

    const dd = (this.peakEquity - equity) / this.peakEquity;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;
  }

  private openPosition(index: number, plan: OrderPlan): void {
    if (!plan.quantity || !plan.side || !plan.entryPrice) return;

    const fee = this.config.feeRate;

    const grossCost = plan.quantity * plan.entryPrice;
    const feeCost = grossCost * fee;
    const totalCost = grossCost + feeCost;

    if (totalCost > this.cashKrw) {
      return;
    }

    this.cashKrw -= totalCost;

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
      initialStopLoss: plan.stopLoss,
    };
  }

  private closePosition(
    index: number,
    exitPrice: number,
    reason: BacktestTrade['exitReason'],
  ): void {
    if (!this.position) return;

    const fee = this.config.feeRate;

    const { entryPrice, quantity, entryIndex, side } = this.position;

    const grossProceeds = quantity * exitPrice;
    const feeCost = grossProceeds * fee;
    const netProceeds = grossProceeds - feeCost;

    this.cashKrw += netProceeds;

    const entryFee = quantity * entryPrice * fee;
    const exitFee = quantity * exitPrice * fee;
    const pnl = (exitPrice - entryPrice) * quantity - (entryFee + exitFee);

    const pnlPercent = (pnl / this.config.initialCapitalKrw) * 100;

    this.realizedPnlToday += pnl / this.config.initialCapitalKrw;

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

  private buildResult(): BacktestResult {
    const winningTrades = this.trades.filter((t) => t.pnl > 0);
    const losingTrades = this.trades.filter((t) => t.pnl <= 0);
    const totalPnl = this.trades.reduce((sum, t) => sum + t.pnl, 0);
    const totalPnlPercent = (totalPnl / this.config.initialCapitalKrw) * 100;

    return {
      totalTrades: this.trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: this.trades.length ? (winningTrades.length / this.trades.length) * 100 : 0,
      totalPnl,
      totalPnlPercent,
      maxDrawdown: this.maxDrawdown * 100,
      sharpeRatio: 0,
      trades: this.trades,
      equityCurve: this.equityCurve,
      signalsDetected: this.signalCount,
      debugStats: this.debugStats,
    };
  }
}
