import {
  BotConfig,
  BotState,
  VolatilitySignal,
  TradeResult,
  TradeSide,
  Position,
  Candle,
} from '../types';
import { StateMachine } from './StateMachine';
import { DeepSeekAgent } from '../agent/DeepSeekAgent';
import { RiskManager } from '../risk/RiskManager';
import { UpbitService } from '../exchange/UpbitService';
import { SupabaseLogger } from '../logging/SupabaseLogger';
import { OrderPlanner, RiskPolicy, PortfolioState, OrderPlan } from '../planner/OrderPlanner';
import { UpbitWebSocket, TickerData, TradeData, CandleData } from '../websocket/UpbitWebSocket';
import { MarketDataService } from '../market/MarketDataService';
import { getRiskScaleForSymbol, getVolatilityBasedSlTp, getSymbolConfig } from '../config/config';
import {
  VolatilityThresholds,
  detectVolatilitySignal,
  calculateRSI,
  calculateSMA,
  calculateEMA,
  calculatePnl,
  calculateUnrealizedPnl,
} from '../trading/TradingCore';

interface SymbolPosition extends Position {
  stopLoss?: number;
  targetPrice?: number;
}

interface SymbolState {
  symbol: string;
  marketData: MarketDataService;
  thresholds: VolatilityThresholds;
  position: SymbolPosition | null;
  cooldownUntil: number;
  lastPrice: number;
  candles: Candle[];
  lastCandleTime: number;
  lastAnalyzedCandleTime: number;
}

export class TradingBotWS {
  private readonly stateMachine: StateMachine;
  private readonly symbolStates: Map<string, SymbolState> = new Map();
  private readonly agent: DeepSeekAgent;
  private readonly riskManager: RiskManager;
  private readonly exchange: UpbitService;
  private readonly logger: SupabaseLogger;
  private readonly planner: OrderPlanner;
  private readonly ws: UpbitWebSocket;
  private realizedPnlToday = 0;
  private analyzeInterval: NodeJS.Timeout | null = null;

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
    this.ws = new UpbitWebSocket(config);

    this.initializeSymbols();
    this.setupWebSocketHandlers();

    this.stateMachine.onStateChange((state) => {
      console.log(`[${new Date().toISOString()}] State: ${state}`);
    });
  }

  private initializeSymbols(): void {
    for (const symbol of this.config.symbols) {
      const symbolConfig = getSymbolConfig(symbol);
      const cfg = { ...this.config, symbols: [symbol] };

      this.symbolStates.set(symbol, {
        symbol,
        marketData: new MarketDataService(cfg, symbol),
        thresholds: {
          atrMultiplier: symbolConfig.atrMultiplier,
          priceSurgePct: symbolConfig.priceSurgePct,
          volumeSpikeMultiplier: symbolConfig.volumeSpikeMultiplier,
        },
        position: null,
        cooldownUntil: 0,
        lastPrice: 0,
        candles: [],
        lastCandleTime: 0,
        lastAnalyzedCandleTime: 0,
      });
    }
  }

  private setupWebSocketHandlers(): void {
    this.ws.on('ticker', (data: TickerData) => this.handleTicker(data));
    this.ws.on('trade', (data: TradeData) => this.handleTrade(data));
    this.ws.on('candle', (data: CandleData) => this.handleCandle(data));
    this.ws.on('myOrder', (data) => this.handleMyOrder(data));
    this.ws.on('error', (error) => console.error('WebSocket error:', error));
  }

  public async start(verbose = false): Promise<void> {
    console.log('🚀 Trading Bot Started (WebSocket Mode)');
    console.log(`Symbols: ${this.config.symbols.join(', ')}`);

    this.ws.setVerbose(verbose);

    await this.initializeRiskManager();
    await this.loadInitialCandles();
    await this.ws.connect();

    this.stateMachine.transition(BotState.MONITORING);

    this.analyzeInterval = setInterval(() => this.analyzeAllSymbols(), this.config.intervalMs);
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
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('⚠️ Failed to fetch initial equity:', msg);
      this.riskManager.setInitialEquity(0);
    }
  }

  private async loadInitialCandles(): Promise<void> {
    console.log('📥 Loading initial candle data...');
    for (const state of this.symbolStates.values()) {
      try {
        const data = await state.marketData.fetchLatestData();
        state.candles = data.candles;
        state.lastPrice = data.price;
        state.lastCandleTime = Date.now();
        this.logCandleInfo(state.symbol, data.candles, data.price);
      } catch (error) {
        console.error(`   ${state.symbol}: Failed to load candles`);
      }
    }
  }

  private logCandleInfo(symbol: string, candles: Candle[], currentPrice: number): void {
    const count = candles.length;
    if (count === 0) {
      console.log(`   ${symbol}: No candles loaded`);
      return;
    }

    const first = candles[0];
    const last = candles[count - 1];
    const high = Math.max(...candles.map((c) => c.high));
    const low = Math.min(...candles.map((c) => c.low));

    console.log(`   ${symbol}: ${count} candles loaded`);
    console.log(`     현재가: ${currentPrice.toLocaleString()}`);
    console.log(
      `     기간: ${new Date(first.timestamp).toLocaleString()} ~ ${new Date(last.timestamp).toLocaleString()}`,
    );
    console.log(`     고가/저가: ${high.toLocaleString()} / ${low.toLocaleString()}`);
    console.log(
      `     최근 5봉 종가: ${candles
        .slice(-5)
        .map((c) => c.close.toLocaleString())
        .join(' → ')}`,
    );
  }

  public stop(): void {
    if (this.analyzeInterval) {
      clearInterval(this.analyzeInterval);
      this.analyzeInterval = null;
    }
    this.ws.disconnect();
    this.stateMachine.forceState(BotState.IDLE);
    console.log('🛑 Trading Bot Stopped');
  }

  private handleTicker(data: TickerData): void {
    const state = this.symbolStates.get(data.code);
    if (!state) return;

    state.lastPrice = data.trade_price;

    if (state.position) {
      state.position.unrealizedPnl = calculateUnrealizedPnl(state.position, data.trade_price);
    }
  }

  private handleTrade(data: TradeData): void {
    const state = this.symbolStates.get(data.code);
    if (!state) return;

    const now = Date.now();
    const candleInterval = 5 * 60 * 1000;

    if (now - state.lastCandleTime >= candleInterval) {
      this.updateCandles(state, data);
      state.lastCandleTime = now;
    }
  }

  private updateCandles(state: SymbolState, trade: TradeData): void {
    const lastCandle = state.candles[state.candles.length - 1];
    if (!lastCandle) return;

    const newCandle: Candle = {
      timestamp: Date.now(),
      open: lastCandle.close,
      high: trade.trade_price,
      low: trade.trade_price,
      close: trade.trade_price,
      volume: trade.trade_volume,
    };

    state.candles.push(newCandle);
    if (state.candles.length > 100) {
      state.candles.shift();
    }
  }

  private handleCandle(data: CandleData): void {
    const state = this.symbolStates.get(data.code);
    if (!state) return;

    const newCandle: Candle = {
      timestamp: data.timestamp,
      open: data.opening_price,
      high: data.high_price,
      low: data.low_price,
      close: data.trade_price,
      volume: data.candle_acc_trade_volume,
    };

    const lastCandle = state.candles[state.candles.length - 1];
    if (lastCandle && lastCandle.timestamp === newCandle.timestamp) {
      state.candles[state.candles.length - 1] = newCandle;
    } else {
      state.candles.push(newCandle);
      if (state.candles.length > 100) state.candles.shift();
      state.lastCandleTime = Date.now();
    }
  }

  private handleMyOrder(data: { code: string; side: string; state: string }): void {
    console.log(`📬 Order update: ${data.code} ${data.side} ${data.state}`);
  }

  private async analyzeAllSymbols(): Promise<void> {
    if (this.stateMachine.getState() !== BotState.MONITORING) return;

    for (const state of this.symbolStates.values()) {
      if (this.isInCooldown(state)) continue;

      if (state.position) {
        await this.managePosition(state, state.lastPrice);
        continue;
      }

      // 🔹 이 지점에서 바로 '이번 캔들은 한 번만 분석'으로 마킹
      if (state.lastCandleTime <= state.lastAnalyzedCandleTime) continue;
      state.lastAnalyzedCandleTime = state.lastCandleTime;

      const signal = detectVolatilitySignal(state.candles, state.thresholds);
      if (!signal) continue;

      console.log(`⚡ [${state.symbol}] Signal: ${signal.type} (${signal.direction})`);
      await this.analyzeAndTrade(state, signal);
    }
  }

  private isInCooldown(state: SymbolState): boolean {
    return Date.now() < state.cooldownUntil;
  }

  private async analyzeAndTrade(state: SymbolState, signal: VolatilitySignal): Promise<void> {
    const rsi = calculateRSI(state.candles);
    const sma20 = calculateSMA(state.candles, 20);
    const ema9 = calculateEMA(state.candles, 9);

    const marketData = {
      symbol: state.symbol,
      price: state.lastPrice,
      timestamp: Date.now(),
      candles: state.candles,
    };

    const decision = await this.agent.analyze(marketData, signal, state.position, rsi, sma20, ema9);

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
      current_price: state.lastPrice,
      rsi,
      sma20,
      ema9,
    });

    if (!decision.shouldTrade || !decision.side) return;

    const portfolio = await this.buildPortfolioState();

    const volatilityRatio = signal.atrPercent ?? 0.03;
    const riskScale = getRiskScaleForSymbol(state.symbol);
    const customSlTp = getVolatilityBasedSlTp(state.symbol, volatilityRatio);

    const plan = this.planner.planOrder({
      decision,
      marketData,
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

    await this.executePlan(state, plan);
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

  private async executePlan(state: SymbolState, plan: OrderPlan): Promise<void> {
    if (!plan.side || !plan.quantity) return;

    try {
      const order = await this.exchange.createOrder({
        market: state.symbol,
        side: plan.side === TradeSide.LONG ? 'bid' : 'ask',
        ord_type: 'price',
        price: String(Math.floor(plan.notionalKrw || plan.quantity * state.lastPrice)),
      });

      state.position = {
        symbol: state.symbol,
        side: plan.side,
        entryPrice: plan.entryPrice || state.lastPrice,
        quantity: plan.quantity,
        timestamp: Date.now(),
        unrealizedPnl: 0,
        stopLoss: plan.stopLoss,
        targetPrice: plan.targetPrice,
      };

      console.log(`✅ [${state.symbol}] Order: ${plan.side} ${plan.quantity} @ ${state.lastPrice}`);

      await this.logger.logTrade({
        symbol: state.symbol,
        side: plan.side,
        action: 'OPEN',
        price: plan.entryPrice || state.lastPrice,
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

      const { pnl, pnlPercent } = calculatePnl(state.position, currentPrice);
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
