import { BotConfig, BotState, VolatilitySignal, TradeResult, TradeSide, Position } from '../types';
import { StateMachine } from './StateMachine';
import { MarketDataService } from '../market/MarketDataService';
import { VolatilityTrigger } from '../triggers/VolatilityTrigger';
import { DeepSeekAgent } from '../agent/DeepSeekAgent';
import { RiskManager } from '../risk/RiskManager';
import { UpbitService } from '../exchange/UpbitService';
import { SupabaseLogger } from '../logging/SupabaseLogger';
import { OrderPlanner, RiskPolicy, PortfolioState, OrderPlan } from '../planner/OrderPlanner';
import { getRiskScaleForSymbol, getVolatilityBasedSlTp } from '../config/config';

interface SymbolState {
  symbol: string;
  marketData: MarketDataService;
  volatilityTrigger: VolatilityTrigger;
  position: Position | null;
  cooldownUntil: number;
  lastAnalyzedCandleTime: number;
}

export class TradingBot {
  private readonly stateMachine: StateMachine;
  private readonly symbolStates: Map<string, SymbolState> = new Map();
  private readonly agent: DeepSeekAgent;
  private readonly riskManager: RiskManager;
  private readonly exchange: UpbitService;
  private readonly logger: SupabaseLogger;
  private readonly planner: OrderPlanner;
  private intervalId: NodeJS.Timeout | null = null;
  private realizedPnlToday = 0;

  public constructor(
    private readonly config: BotConfig,
    riskPolicy: RiskPolicy,
  ) {
    this.stateMachine = new StateMachine();
    this.agent = new DeepSeekAgent(config.deepseekApiKey);
    this.riskManager = new RiskManager(config.riskLimits);
    this.exchange = new UpbitService(config);
    this.logger = new SupabaseLogger();
    this.planner = new OrderPlanner(riskPolicy);

    this.initializeSymbols();

    this.stateMachine.onStateChange((state) => {
      console.log(`[${new Date().toISOString()}] State: ${state}`);
    });
  }

  private initializeSymbols(): void {
    for (const symbol of this.config.symbols) {
      const symbolConfig = { ...this.config, symbols: [symbol] };
      this.symbolStates.set(symbol, {
        symbol,
        marketData: new MarketDataService(symbolConfig, symbol),
        volatilityTrigger: new VolatilityTrigger(this.config),
        position: null,
        cooldownUntil: 0,
        lastAnalyzedCandleTime: 0,
      });
    }
  }

  public async start(): Promise<void> {
    console.log('🚀 Trading Bot Started (Upbit)');
    console.log(`Symbols: ${this.config.symbols.join(', ')}`);
    console.log(`Interval: ${this.config.intervalMs}ms`);

    await this.initializeRiskManager();

    this.stateMachine.transition(BotState.MONITORING);
    this.intervalId = setInterval(() => this.tick(), this.config.intervalMs);
  }

  private async initializeRiskManager(): Promise<void> {
    try {
      const accounts = await this.exchange.getAccounts();
      const krwAccount = accounts.find((a) => a.currency === 'KRW');
      const initialEquity = krwAccount ? parseFloat(krwAccount.balance) : 0;

      this.riskManager.setInitialEquity(initialEquity);
      console.log(`💰 Initial Equity: ${initialEquity.toLocaleString()} KRW`);
      console.log(
        `📉 Max Daily Loss: ${this.riskManager.getMaxDailyLossKrw().toLocaleString()} KRW`,
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.warn('⚠️ Failed to fetch initial equity:', errorMessage);
      if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        console.warn('   → API 키가 잘못되었거나 권한이 없습니다.');
        console.warn('   → UPBIT_ACCESS_KEY, UPBIT_SECRET_KEY 확인 필요');
      }
      if (errorMessage.includes('허용되지 않은')) {
        console.warn('   → IP가 허용 목록에 없습니다. 업비트에서 IP 등록 필요');
      }
      this.riskManager.setInitialEquity(0);
    }
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.stateMachine.forceState(BotState.IDLE);
    console.log('🛑 Trading Bot Stopped');
  }

  private async tick(): Promise<void> {
    try {
      const state = this.stateMachine.getState();
      if (state !== BotState.MONITORING) return;

      await Promise.all(Array.from(this.symbolStates.values()).map((s) => this.processSymbol(s)));
    } catch (error) {
      console.error('Tick error:', error);
      this.stateMachine.forceState(BotState.ERROR);
      setTimeout(() => this.stateMachine.transition(BotState.MONITORING), 5000);
    }
  }

  private async processSymbol(state: SymbolState): Promise<void> {
    if (this.isInCooldown(state)) return;

    const data = await state.marketData.fetchLatestData();

    if (state.position) {
      this.updatePositionPnl(state, data.price);
      await this.managePosition(state, data.price);
      return;
    }

    const latestCandleTime = data.candles[data.candles.length - 1]?.timestamp ?? 0;
    if (latestCandleTime <= state.lastAnalyzedCandleTime) return;

    const signal = state.volatilityTrigger.analyze(data.candles);
    if (signal) {
      console.log(`⚡ [${state.symbol}] Signal: ${signal.type} (${signal.direction})`);
      state.lastAnalyzedCandleTime = latestCandleTime;
      await this.analyzeAndTrade(state, signal);
    }
  }

  private isInCooldown(state: SymbolState): boolean {
    return Date.now() < state.cooldownUntil;
  }

  private updatePositionPnl(state: SymbolState, currentPrice: number): void {
    if (!state.position) return;
    const direction = state.position.side === TradeSide.LONG ? 1 : -1;
    state.position.unrealizedPnl =
      ((currentPrice - state.position.entryPrice) / state.position.entryPrice) * 100 * direction;
  }

  private async analyzeAndTrade(state: SymbolState, signal: VolatilitySignal): Promise<void> {
    const data = await state.marketData.fetchLatestData();
    const rsi = state.marketData.calculateRSI();
    const sma20 = state.marketData.calculateSMA(20);
    const ema9 = state.marketData.calculateEMA(9);

    const decision = await this.agent.analyze(data, signal, state.position, rsi, sma20, ema9);

    console.log(`🤖 [${state.symbol}] Decision: ${decision.shouldTrade ? 'TRADE' : 'SKIP'}`);
    console.log(`   Confidence: ${decision.confidence}%, Reasoning: ${decision.reasoning}`);

    await this.logger.logDecision({
      symbol: state.symbol,
      signal_type: signal.type,
      signal_direction: signal.direction,
      should_trade: decision.shouldTrade,
      side: decision.side || null,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      current_price: data.price,
      rsi,
      sma20,
      ema9,
    });

    if (!decision.shouldTrade || !decision.side) return;

    const portfolio = await this.buildPortfolioState();
    const volatilityPercent = signal.atrPercent ? signal.atrPercent * 100 : 30;
    const riskScale = getRiskScaleForSymbol(state.symbol);
    const customSlTp = getVolatilityBasedSlTp(state.symbol, volatilityPercent);

    const plan = this.planner.planOrder({
      decision,
      marketData: data,
      portfolio,
      volatility: signal,
      riskScale,
      customSlTp,
    });

    this.logOrderPlan(state.symbol, plan);

    if (!plan.shouldExecute) {
      console.log(`⛔ [${state.symbol}] Order rejected: ${plan.reason}`);
      return;
    }

    await this.executePlan(state, plan, data.price);
  }

  private async buildPortfolioState(): Promise<PortfolioState> {
    const accounts = await this.exchange.getAccounts();
    const krwAccount = accounts.find((a) => a.currency === 'KRW');
    const cashKrw = krwAccount ? parseFloat(krwAccount.balance) : 0;

    const positions = Array.from(this.symbolStates.values())
      .map((s) => s.position)
      .filter((p): p is Position => p !== null);

    const positionValue = positions.reduce((sum, p) => sum + p.quantity * p.entryPrice, 0);
    const totalEquityKrw = cashKrw + positionValue;

    return { totalEquityKrw, cashKrw, positions, realizedPnlTodayPct: this.realizedPnlToday };
  }

  private logOrderPlan(symbol: string, plan: OrderPlan): void {
    console.log(`📋 [${symbol}] Order Plan:`);
    console.log(`   Execute: ${plan.shouldExecute}, Reason: ${plan.reason}`);
    if (plan.shouldExecute && plan.riskSummary) {
      console.log(`   Risk: ${(plan.riskSummary.appliedRiskPct * 100).toFixed(2)}%`);
      console.log(`   Notional: ${plan.notionalKrw?.toFixed(0)} KRW, Qty: ${plan.quantity}`);
    }
  }

  private async executePlan(
    state: SymbolState,
    plan: OrderPlan,
    currentPrice: number,
  ): Promise<void> {
    if (!plan.side || !plan.quantity) return;

    try {
      const order = await this.exchange.createOrder({
        market: state.symbol,
        side: plan.side === TradeSide.LONG ? 'bid' : 'ask',
        ord_type: 'price',
        price: String(Math.floor(plan.notionalKrw || plan.quantity * currentPrice)),
      });

      state.position = {
        symbol: state.symbol,
        side: plan.side,
        entryPrice: plan.entryPrice || currentPrice,
        quantity: plan.quantity,
        timestamp: Date.now(),
        unrealizedPnl: 0,
      };

      console.log(`✅ [${state.symbol}] Order: ${plan.side} ${plan.quantity} @ ${currentPrice}`);

      await this.logger.logTrade({
        symbol: state.symbol,
        side: plan.side,
        action: 'OPEN',
        price: plan.entryPrice || currentPrice,
        quantity: plan.quantity,
        order_id: order.uuid,
      });

      this.enterCooldown(state);
    } catch (error) {
      console.error(`❌ [${state.symbol}] Trade failed:`, error);
    }
  }

  private async managePosition(state: SymbolState, currentPrice: number): Promise<void> {
    if (!state.position) return;

    const riskAction = this.riskManager.checkPositionRisk(state.position, currentPrice);
    if (riskAction.action !== 'CLOSE') return;

    console.log(`🔴 [${state.symbol}] Closing: ${riskAction.reason}`);

    try {
      const order = await this.exchange.createOrder({
        market: state.symbol,
        side: state.position.side === TradeSide.LONG ? 'ask' : 'bid',
        ord_type: 'market',
        volume: String(state.position.quantity),
      });

      const pnl = (currentPrice - state.position.entryPrice) * state.position.quantity;
      const pnlPercent =
        ((currentPrice - state.position.entryPrice) / state.position.entryPrice) *
        100 *
        (state.position.side === TradeSide.LONG ? 1 : -1);

      this.realizedPnlToday += pnlPercent / 100;

      const result: TradeResult = {
        orderId: order.uuid,
        side: state.position.side,
        entryPrice: state.position.entryPrice,
        exitPrice: currentPrice,
        quantity: state.position.quantity,
        pnl,
        pnlPercent,
        exitReason: riskAction.reason as TradeResult['exitReason'],
      };

      this.riskManager.recordTrade(result);
      this.logTradeResult(state.symbol, result);

      await this.logger.logTrade({
        symbol: state.symbol,
        side: state.position.side,
        action: 'CLOSE',
        price: currentPrice,
        quantity: state.position.quantity,
        order_id: order.uuid,
        pnl,
        pnl_percent: pnlPercent,
        exit_reason: riskAction.reason,
      });

      state.position = null;
      this.enterCooldown(state);
    } catch (error) {
      console.error(`❌ [${state.symbol}] Close failed:`, error);
    }
  }

  private enterCooldown(state: SymbolState): void {
    state.cooldownUntil = Date.now() + this.config.cooldownMs;
    console.log(`⏳ [${state.symbol}] Cooldown ${this.config.cooldownMs / 1000}s`);
  }

  private logTradeResult(symbol: string, result: TradeResult): void {
    const emoji = (result.pnl ?? 0) >= 0 ? '💰' : '📉';
    console.log(`${emoji} [${symbol}] Entry: ${result.entryPrice} -> Exit: ${result.exitPrice}`);
    console.log(`   PnL: ${result.pnl?.toFixed(2)} (${result.pnlPercent?.toFixed(2)}%)`);

    const stats = this.riskManager.getDailyStats();
    console.log(`📊 Daily: ${stats.wins}W/${stats.losses}L, PnL: ${stats.totalPnl.toFixed(2)}`);
  }

  public getStats() {
    return this.riskManager.getDailyStats();
  }

  public getState(): BotState {
    return this.stateMachine.getState();
  }

  public getSymbolStates(): Map<string, SymbolState> {
    return this.symbolStates;
  }
}
