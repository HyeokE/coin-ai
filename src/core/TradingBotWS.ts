import { DeepSeekAgent } from '../agent/DeepSeekAgent';
import {
  getRiskScaleForSymbol,
  getSymbolConfig,
  getVolatilityBasedSlTp,
  BREAKOUT_STRATEGY_CONFIG,
} from '../config/config';
import { UpbitService } from '../exchange/UpbitService';
import { SupabaseLogger } from '../logging/SupabaseLogger';
import { MarketDataService } from '../market/MarketDataService';
import { OrderPlan, OrderPlanner, PortfolioState, RiskPolicy } from '../planner/OrderPlanner';
import { RiskManager } from '../risk/RiskManager';
import {
  VolatilityThresholds,
  calculateEMA,
  calculatePnl,
  calculateRSI,
  calculateSMA,
  calculateATR,
  calculateUnrealizedPnl,
  detectVolatilitySignalAt,
} from '../trading/TradingCore';
import { emaSeries, rsiSeries, atrSeries } from '../indicators';
import { evaluateBreakoutEntryAtIndex } from '../strategies/breakoutEntry';
import {
  BotConfig,
  BotState,
  Candle,
  Position,
  PositionAction,
  PositionEvaluation,
  TradeResult,
  TradeSide,
  VolatilitySignal,
} from '../types';
import { CandleData, TickerData, TradeData, UpbitWebSocket } from '../websocket/UpbitWebSocket';
import { StateMachine } from './StateMachine';
import { GLOBAL_CONFIG } from '../config/config';

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
  lastAiAnalysisTime: number;
  candleCount: number;
}

export class TradingBotWS {
  private static readonly AI_COOLDOWN_MS = 30_000;

  private readonly stateMachine: StateMachine;
  private readonly symbolStates: Map<string, SymbolState> = new Map();
  private readonly agent: DeepSeekAgent;
  private readonly riskManager: RiskManager;
  private readonly exchange: UpbitService;
  private readonly logger: SupabaseLogger;
  private readonly planner: OrderPlanner;
  private readonly ws: UpbitWebSocket;
  private realizedPnlToday = 0;
  private isRunning = false;

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
        lastAiAnalysisTime: 0,
        candleCount: 0,
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

    this.isRunning = true;
    this.runAnalysisLoop();
  }

  private async initializeRiskManager(): Promise<void> {
    try {
      const accounts = await this.exchange.getAccounts();
      const krwAccount = accounts.find((a) => a.currency === 'KRW');
      const krwBalance = krwAccount ? parseFloat(krwAccount.balance) : 0;

      await this.loadExistingPositions(accounts);

      const positionValue = Array.from(this.symbolStates.values())
        .filter((s) => s.position !== null)
        .reduce((sum, s) => sum + s.position!.quantity * s.position!.entryPrice, 0);

      const initialEquity = krwBalance + positionValue;

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

  private async loadExistingPositions(
    accounts: { currency: string; balance: string; avg_buy_price: string }[],
  ): Promise<void> {
    console.log('📦 Loading existing positions from exchange...');

    for (const account of accounts) {
      if (account.currency === 'KRW') continue;

      const symbol = `KRW-${account.currency}`;
      const state = this.symbolStates.get(symbol);
      if (!state) continue;

      const quantity = parseFloat(account.balance);
      const entryPrice = parseFloat(account.avg_buy_price);

      if (quantity <= 0 || entryPrice <= 0) continue;

      state.position = {
        symbol,
        side: TradeSide.LONG,
        entryPrice,
        quantity,
        timestamp: Date.now(),
        unrealizedPnl: 0,
      };

      console.log(`   ${symbol}: ${quantity.toFixed(8)} @ ${entryPrice.toLocaleString()} KRW`);
    }

    const loadedCount = Array.from(this.symbolStates.values()).filter(
      (s) => s.position !== null,
    ).length;
    console.log(`   Loaded ${loadedCount} existing positions`);
  }

  private async loadInitialCandles(): Promise<void> {
    console.log('📥 Loading initial candle data...');
    for (const state of this.symbolStates.values()) {
      try {
        const data = await state.marketData.fetchLatestData();
        state.candles = data.candles;
        state.lastPrice = data.price;
        state.candleCount = data.candles.length;

        const lastCandle = data.candles[data.candles.length - 1];
        const timestamp = lastCandle?.timestamp ?? Date.now();
        state.lastCandleTime = this.normalizeToCandle(timestamp);
        state.lastAnalyzedCandleTime = state.lastCandleTime;

        this.logCandleInfo(state.symbol, data.candles, data.price);
      } catch (error) {
        console.error(`   ${state.symbol}: Failed to load candles`);
      }
    }
  }

  private normalizeToCandle(timestamp: number): number {
    const candleMs = GLOBAL_CONFIG.candleMinutes * 60 * 1000;
    return Math.floor(timestamp / candleMs) * candleMs;
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
    this.isRunning = false;
    this.ws.disconnect();
    this.stateMachine.forceState(BotState.IDLE);
    console.log('🛑 Trading Bot Stopped');
  }

  private async runAnalysisLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.analyzeAllSymbols();
      } catch (error) {
        console.error('Analysis loop error:', error);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private handleTicker(data: TickerData): void {
    const state = this.symbolStates.get(data.code);
    if (!state) return;

    state.lastPrice = data.trade_price;

    if (state.position) {
      state.position.unrealizedPnl = calculateUnrealizedPnl(state.position, data.trade_price);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleTrade(_data: TradeData): void {
    // Candle updates come from handleCandle via WebSocket
  }

  private handleCandle(data: CandleData): void {
    const state = this.symbolStates.get(data.code);
    if (!state) return;

    if (data.unit !== GLOBAL_CONFIG.candleMinutes) return;

    const normalizedTimestamp = this.normalizeToCandle(data.timestamp);

    const newCandle: Candle = {
      timestamp: normalizedTimestamp,
      open: data.opening_price,
      high: data.high_price,
      low: data.low_price,
      close: data.trade_price,
      volume: data.candle_acc_trade_volume,
    };

    const lastCandle = state.candles[state.candles.length - 1];
    if (lastCandle && lastCandle.timestamp === normalizedTimestamp) {
      state.candles[state.candles.length - 1] = newCandle;
    } else {
      state.candles.push(newCandle);
      const maxCandles = 1200;
      while (state.candles.length > maxCandles) state.candles.shift();
      state.lastCandleTime = normalizedTimestamp;
      state.candleCount++;
      console.log(
        `🕯️ [${state.symbol}] New ${GLOBAL_CONFIG.candleMinutes}m candle: ${new Date(normalizedTimestamp).toLocaleTimeString()}`,
      );
    }
  }

  private handleMyOrder(data: { code: string; ask_bid: 'ASK' | 'BID'; state: string }): void {
    const side = data.ask_bid === 'BID' ? 'BUY' : 'SELL';
    console.log(`📬 Order update: ${data.code} ${side} ${data.state}`);
  }

  private async analyzeAllSymbols(): Promise<void> {
    if (this.stateMachine.getState() !== BotState.MONITORING) return;

    for (const state of this.symbolStates.values()) {
      if (this.isInCooldown(state)) continue;
      if (!this.hasNewCandle(state)) continue;

      if (state.position) {
        await this.managePosition(state, state.lastPrice);
        continue;
      }

      await this.tryEnterWithBreakout(state);
    }
  }

  private hasNewCandle(state: SymbolState): boolean {
    const lastCandle = state.candles[state.candles.length - 1];
    if (!lastCandle) return false;

    const candleTimestamp = lastCandle.timestamp;
    if (candleTimestamp <= state.lastAnalyzedCandleTime) return false;

    state.lastAnalyzedCandleTime = candleTimestamp;
    return true;
  }

  private isInCooldown(state: SymbolState): boolean {
    return Date.now() < state.cooldownUntil;
  }

  private isAiInCooldown(state: SymbolState): boolean {
    return Date.now() - state.lastAiAnalysisTime < TradingBotWS.AI_COOLDOWN_MS;
  }

  private async analyzeAndTrade(
    state: SymbolState,
    signal: VolatilitySignal,
    rsi: number,
    sma20: number,
    ema9: number,
  ): Promise<void> {
    if (this.isAiInCooldown(state)) {
      console.log(`⏳ [${state.symbol}] AI cooldown active, skipping`);
      return;
    }
    state.lastAiAnalysisTime = Date.now();

    const marketData = {
      symbol: state.symbol,
      price: state.lastPrice,
      timestamp: Date.now(),
      candles: state.candles,
    };

    const portfolio = await this.buildPortfolioState();
    const decision = await this.agent.analyze(
      marketData,
      signal,
      state.position,
      rsi,
      sma20,
      ema9,
      portfolio,
    );

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

  private async tryEnterWithBreakout(state: SymbolState): Promise<void> {
    const idx = state.candles.length - 1;
    if (idx < 250) return;

    const candles = state.candles;
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    const ema200 = emaSeries(closes, 200);
    const ribbonPeriods = [20, 25, 30, 35, 40, 45, 50, 60];
    const ribbon = ribbonPeriods.map((p) => emaSeries(closes, p));
    const rsi = rsiSeries(closes, 14);
    const atr = atrSeries(candles, 14);

    const feeRate = GLOBAL_CONFIG.feeRate;
    const { rsiMin, atrMultiplier, rr, mode, retestLookback } = BREAKOUT_STRATEGY_CONFIG;

    const decision = evaluateBreakoutEntryAtIndex({
      series: { candles, closes, highs, lows, ema200, ribbon, rsi, atr },
      config: { feeRate, rsiMin, atrMultiplier, rr, mode, retestLookback },
      index: idx,
    });

    if (!decision.shouldTrade || !decision.side) return;

    state.lastAiAnalysisTime = Date.now();

    const rsiVal = rsi[idx];
    const sma20 = calculateSMA(candles, 20);
    const ema9 = calculateEMA(candles, 9);

    const marketData = {
      symbol: state.symbol,
      price: state.lastPrice,
      timestamp: Date.now(),
      candles: state.candles,
    };

    const portfolio = await this.buildPortfolioState();

    await this.logger.logDecision({
      symbol: state.symbol,
      signal_type: 'BREAKOUT_RETEST',
      signal_direction: 'LONG',
      should_trade: decision.shouldTrade,
      side: decision.side ?? null,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      current_price: state.lastPrice,
      rsi: rsiVal,
      sma20,
      ema9,
    });

    const riskScale = getRiskScaleForSymbol(state.symbol);
    const price = candles[idx].close;
    const volatilityRatio = atr[idx] > 0 ? atr[idx] / price : 0.03;
    const customSlTp = getVolatilityBasedSlTp(state.symbol, volatilityRatio);

    const plan = this.planner.planOrder({
      decision,
      marketData,
      portfolio,
      volatility: undefined,
      riskScale,
      customSlTp,
    });

    if (decision.stopLoss) plan.stopLoss = decision.stopLoss;
    if (decision.targetPrice) plan.targetPrice = decision.targetPrice;

    this.logOrderPlan(state.symbol, plan);
    if (!plan.shouldExecute) return;

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

  private async getActualBalance(symbol: string): Promise<number> {
    const currency = symbol.replace('KRW-', '');
    const accounts = await this.exchange.getAccounts();
    const account = accounts.find((a) => a.currency === currency);
    return account ? parseFloat(account.balance) : 0;
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

    const realBalance = await this.getActualBalance(state.symbol);
    if (realBalance <= 0) {
      console.log(`⚠️ [${state.symbol}] No actual balance, clearing position`);
      state.position = null;
      return;
    }
    state.position.quantity = realBalance;

    const { entryPrice, stopLoss, targetPrice } = state.position;

    let finalAction: { action: PositionAction; reason: string } = {
      action: PositionAction.HOLD,
      reason: 'NO_ACTION',
    };

    if (stopLoss && currentPrice <= stopLoss) {
      finalAction = { action: PositionAction.CLOSE, reason: 'STOP_LOSS' };
    } else if (targetPrice && currentPrice >= targetPrice) {
      finalAction = { action: PositionAction.CLOSE, reason: 'TAKE_PROFIT' };
    } else {
      const beTriggerR = BREAKOUT_STRATEGY_CONFIG.beTriggerR;
      const risk = entryPrice - (stopLoss || entryPrice * 0.98);
      const currentR = (currentPrice - entryPrice) / risk;

      if (currentR >= beTriggerR && stopLoss && stopLoss < entryPrice) {
        state.position.stopLoss = entryPrice;
        console.log(`🔒 [${state.symbol}] BE activated @ ${entryPrice.toLocaleString()}`);
      }

      const riskAction = this.riskManager.checkPositionRisk(state.position, currentPrice);
      if (riskAction.action === 'CLOSE') {
        finalAction = { action: PositionAction.CLOSE, reason: riskAction.reason ?? 'RISK_TRIGGER' };
      }
    }

    if (finalAction.action === PositionAction.HOLD) return;

    const isTrim = finalAction.action === PositionAction.TRIM_HALF;
    let quantity = isTrim ? state.position.quantity / 2 : state.position.quantity;

    const orderValue = quantity * currentPrice;
    if (orderValue < 5000) {
      if (isTrim) {
        console.log(`⚠️ [${state.symbol}] Trim value < 5000 KRW, skipping`);
        return;
      }
      quantity = state.position.quantity;
    }

    console.log(`🔴 [${state.symbol}] ${finalAction.action}: ${finalAction.reason}`);

    try {
      const order = await this.exchange.createOrder({
        market: state.symbol,
        side: state.position.side === TradeSide.LONG ? 'ask' : 'bid',
        ord_type: 'market',
        volume: String(quantity),
      });

      const { pnl, pnlPercent } = calculatePnl({ ...state.position, quantity }, currentPrice);
      this.realizedPnlToday += pnlPercent / 100;

      const result: TradeResult = {
        orderId: order.uuid,
        side: state.position.side,
        entryPrice: state.position.entryPrice,
        exitPrice: currentPrice,
        quantity,
        pnl,
        pnlPercent,
        exitReason: finalAction.reason as TradeResult['exitReason'],
      };

      this.riskManager.recordTrade(result);
      this.logTradeResult(state.symbol, result);

      await this.logger.logTrade({
        symbol: state.symbol,
        side: state.position.side,
        action: isTrim ? 'TRIM' : 'CLOSE',
        price: currentPrice,
        quantity,
        order_id: order.uuid,
        pnl,
        pnl_percent: pnlPercent,
        exit_reason: finalAction.reason,
      });

      if (isTrim) {
        state.position.quantity -= quantity;
        console.log(`✂️ [${state.symbol}] Trimmed to ${state.position.quantity}`);
      } else {
        state.position = null;
        this.enterCooldown(state);
      }
    } catch (error) {
      console.error(`❌ [${state.symbol}] ${finalAction.action} failed:`, error);
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('insufficient_funds') || msg.includes('under_min_total')) {
        console.log(`⚠️ [${state.symbol}] Clearing invalid position`);
        state.position = null;
      }
    }
  }

  private async evaluatePositionWithAI(
    state: SymbolState,
    currentPrice: number,
  ): Promise<PositionEvaluation> {
    if (!state.position) {
      return { action: PositionAction.HOLD, confidence: 0, reasoning: 'No position' };
    }

    const lastCandle = state.candles[state.candles.length - 1];
    const candleTime = lastCandle?.timestamp ?? 0;

    const rsi = calculateRSI(state.candles);
    const sma20 = calculateSMA(state.candles, 20);
    const ema9 = calculateEMA(state.candles, 9);

    const recentCandles = state.candles.slice(-10);
    const recentReturns = recentCandles.map((c, i) =>
      i === 0 ? 0 : ((c.close - recentCandles[i - 1].close) / recentCandles[i - 1].close) * 100,
    );

    const portfolio = await this.buildPortfolioState();

    const evaluation = await this.agent.evaluatePosition(
      state.position,
      currentPrice,
      rsi,
      sma20,
      ema9,
      recentReturns,
      portfolio,
      candleTime,
    );

    console.log(`🧠 [${state.symbol}] AI Eval: ${evaluation.action} (${evaluation.confidence}%)`);
    console.log(`   Reasoning: ${evaluation.reasoning}`);

    const feeRate = 0.0005;
    const grossPnlPct =
      ((currentPrice - state.position.entryPrice) / state.position.entryPrice) * 100;
    const netPnlPct = grossPnlPct - feeRate * 2 * 100;
    const holdingTimeMin = Math.floor((Date.now() - state.position.timestamp) / 60000);

    await this.logger.logPositionEval({
      symbol: state.symbol,
      action: evaluation.action,
      confidence: evaluation.confidence,
      reasoning: evaluation.reasoning,
      current_price: currentPrice,
      entry_price: state.position.entryPrice,
      gross_pnl_pct: Number(grossPnlPct.toFixed(2)),
      net_pnl_pct: Number(netPnlPct.toFixed(2)),
      holding_time_min: holdingTimeMin,
      rsi,
      sma20,
      ema9,
    });

    return evaluation;
  }

  private synthesizeActions(
    aiEval: PositionEvaluation,
    riskAction: { action: 'HOLD' | 'CLOSE'; reason?: string },
  ): { action: PositionAction; reason: string } {
    if (riskAction.action === 'CLOSE') {
      return { action: PositionAction.CLOSE, reason: riskAction.reason ?? 'RISK_TRIGGER' };
    }

    if (aiEval.action === PositionAction.CLOSE && aiEval.confidence >= 60) {
      return { action: PositionAction.CLOSE, reason: 'AI_CLOSE' };
    }

    if (aiEval.action === PositionAction.TRIM_HALF && aiEval.confidence >= 55) {
      return { action: PositionAction.TRIM_HALF, reason: 'AI_TRIM' };
    }

    return { action: PositionAction.HOLD, reason: 'NO_ACTION' };
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
