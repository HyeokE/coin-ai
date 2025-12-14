import {
  AgentDecision,
  MarketData,
  VolatilitySignal,
  Position,
  TradeSide,
  PositionAction,
  PositionEvaluation,
  Candle,
} from '../types';
import { GLOBAL_CONFIG } from '../config/config';
import { DecisionHistory, DecisionRecord } from './DecisionHistory';
import { FearGreedService } from '../market/FearGreedService';

interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DeepSeekResponse {
  choices: { message: { content: string } }[];
}

export interface PortfolioContext {
  totalEquityKrw: number;
  cashKrw: number;
  positions: Position[];
  realizedPnlTodayPct: number;
}

export interface MarketSentiment {
  fearGreedValue: number;
  fearGreedClass: string;
}

type UnifiedAction = 'BUY' | 'SELL' | 'HOLD' | 'SKIP';

interface UnifiedDecision {
  trade_mode: 'NO_POSITION' | 'HAS_POSITION';
  action: UnifiedAction;
  confidence: number;
  entryPrice: number | null;
  targetPrice: number | null;
  stopLoss: number | null;
  suggestedExitPrice: number | null;
  reasoning: string;
}

export interface SuggestedEntryPlan {
  entryPrice: number;
  targetPrice: number;
  stopLoss: number;
}

interface EvaluationCache {
  candleTime: number;
  evaluation: PositionEvaluation;
}

export class DeepSeekAgent {
  private readonly baseUrl = 'https://api.deepseek.com';
  private readonly evaluationCache = new Map<string, EvaluationCache>();
  private readonly decisionHistory = new DecisionHistory(50);
  private readonly fearGreedService = new FearGreedService();
  private cachedSentiment: MarketSentiment | null = null;
  private readonly candleContextDays = Number(process.env.AI_CANDLE_DAYS || 30);

  public constructor(private readonly apiKey: string) {}

  public getDecisionHistory(): DecisionHistory {
    return this.decisionHistory;
  }

  public async refreshSentiment(): Promise<MarketSentiment | null> {
    const fg = await this.fearGreedService.getFearGreedIndex();
    if (fg) {
      this.cachedSentiment = {
        fearGreedValue: fg.value,
        fearGreedClass: fg.classification,
      };
    }
    return this.cachedSentiment;
  }

  public async analyze(
    marketData: MarketData,
    signal: VolatilitySignal | null,
    currentPosition: Position | null,
    rsi: number,
    sma20: number,
    ema9: number,
    portfolio: PortfolioContext,
    suggestedEntryPlan?: SuggestedEntryPlan,
  ): Promise<AgentDecision> {
    const recentCandles = marketData.candles.slice(-10);
    const recentReturns = recentCandles.map((c, i) =>
      i === 0 ? 0 : ((c.close - recentCandles[i - 1].close) / recentCandles[i - 1].close) * 100,
    );

    const sentiment = await this.refreshSentiment();
    const recentDecisions = this.decisionHistory.getBySymbol(marketData.symbol, 20);

    try {
      const raw = await this.callUnified(
        marketData,
        signal,
        currentPosition,
        rsi,
        sma20,
        ema9,
        recentReturns.slice(-5),
        portfolio,
        marketData.candles,
        suggestedEntryPlan,
        undefined,
        sentiment,
        recentDecisions,
      );

      const resolvedEntry = raw.entryPrice ?? suggestedEntryPlan?.entryPrice ?? marketData.price;
      const resolvedStop = raw.stopLoss ?? suggestedEntryPlan?.stopLoss ?? null;
      const resolvedTarget = raw.targetPrice ?? suggestedEntryPlan?.targetPrice ?? null;

      const isBuy =
        raw.trade_mode === 'NO_POSITION' &&
        raw.action === 'BUY' &&
        resolvedStop != null &&
        resolvedTarget != null &&
        resolvedStop < resolvedEntry &&
        resolvedEntry < resolvedTarget;

      const decision: AgentDecision = {
        shouldTrade: isBuy,
        side: isBuy ? TradeSide.LONG : undefined,
        confidence: this.clamp(raw.confidence, 0, 100),
        entryPrice: isBuy ? resolvedEntry : marketData.price,
        targetPrice: isBuy ? resolvedTarget! : undefined,
        stopLoss: isBuy ? resolvedStop! : undefined,
        reasoning: raw.reasoning,
      };

      this.decisionHistory.add({
        timestamp: Date.now(),
        symbol: marketData.symbol,
        action: raw.action,
        confidence: decision.confidence,
        reasoning: raw.reasoning,
        price: marketData.price,
        result: 'PENDING',
      });

      return decision;
    } catch (error) {
      console.error('DeepSeek analyze error:', error);
      return { shouldTrade: false, confidence: 0, reasoning: 'API error' };
    }
  }

  public async evaluatePosition(
    position: Position,
    currentPrice: number,
    rsi: number,
    sma20: number,
    ema9: number,
    recentReturns: number[],
    portfolio: PortfolioContext,
    candleTime: number,
    candlesForContext?: Candle[],
  ): Promise<PositionEvaluation> {
    const cached = this.evaluationCache.get(position.symbol);
    if (cached && cached.candleTime === candleTime) {
      return cached.evaluation;
    }

    const sentiment = this.cachedSentiment;
    const recentDecisions = this.decisionHistory.getBySymbol(position.symbol, 20);

    try {
      const raw = await this.callUnified(
        null,
        null,
        position,
        rsi,
        sma20,
        ema9,
        recentReturns.slice(-5),
        portfolio,
        candlesForContext,
        undefined,
        currentPrice,
        sentiment,
        recentDecisions,
      );

      const actionMap: Record<UnifiedAction, PositionAction> = {
        SELL: PositionAction.CLOSE,
        BUY: PositionAction.HOLD,
        HOLD: PositionAction.HOLD,
        SKIP: PositionAction.HOLD,
      };

      const evaluation: PositionEvaluation = {
        action: actionMap[raw.action],
        confidence: this.clamp(raw.confidence, 0, 100),
        reasoning: raw.reasoning,
        suggestedExitPrice: raw.suggestedExitPrice ?? undefined,
      };

      this.evaluationCache.set(position.symbol, { candleTime, evaluation });
      return evaluation;
    } catch (error) {
      console.error('DeepSeek evaluate error:', error);
      return { action: PositionAction.HOLD, confidence: 0, reasoning: 'API error' };
    }
  }

  private async callUnified(
    marketData: MarketData | null,
    signal: VolatilitySignal | null,
    position: Position | null,
    rsi: number,
    sma20: number,
    ema9: number,
    recentReturns: number[],
    portfolio: PortfolioContext,
    candlesForContext?: Candle[],
    suggestedEntryPlan?: SuggestedEntryPlan,
    currentPrice?: number,
    sentiment?: MarketSentiment | null,
    recentDecisions?: DecisionRecord[],
  ): Promise<UnifiedDecision> {
    const prompt = this.buildUnifiedPrompt(
      marketData,
      signal,
      position,
      rsi,
      sma20,
      ema9,
      recentReturns,
      portfolio,
      candlesForContext,
      suggestedEntryPlan,
      currentPrice,
      sentiment,
      recentDecisions,
    );

    const messages: DeepSeekMessage[] = [
      {
        role: 'system',
        content: `You are a trading AI. You must respond ONLY with valid JSON. No markdown, no explanation, just pure JSON object.

EXAMPLE JSON OUTPUT:
{
  "trade_mode": "NO_POSITION",
  "action": "BUY",
  "confidence": 75,
  "entryPrice": 50000,
  "targetPrice": 51000,
  "stopLoss": 49500,
  "suggestedExitPrice": null,
  "reasoning": "RSI oversold with bullish divergence"
}`,
      },
      { role: 'user', content: prompt },
    ];

    const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    const useJsonFormat = model === 'deepseek-chat';

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 8000,
        ...(useJsonFormat && { response_format: { type: 'json_object' } }),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
    }

    const responseText = await response.text();
    if (!responseText) {
      throw new Error('DeepSeek returned empty response');
    }

    const data = JSON.parse(responseText) as DeepSeekResponse;
    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error('DeepSeek returned empty content');
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    return JSON.parse(jsonMatch[0]) as UnifiedDecision;
  }

  private buildUnifiedPrompt(
    marketData: MarketData | null,
    signal: VolatilitySignal | null,
    position: Position | null,
    rsi: number,
    sma20: number,
    ema9: number,
    recentReturns: number[],
    portfolio: PortfolioContext,
    candlesForContext?: Candle[],
    suggestedEntryPlan?: SuggestedEntryPlan,
    currentPrice?: number,
    sentiment?: MarketSentiment | null,
    recentDecisions?: DecisionRecord[],
  ): string {
    const feeRate = GLOBAL_CONFIG.feeRate;
    const roundTripFee = feeRate * 2;
    const tradeMode = position ? 'HAS_POSITION' : 'NO_POSITION';
    const price = currentPrice ?? marketData?.price ?? 0;

    const marketState = marketData
      ? {
          symbol: marketData.symbol,
          current_price: marketData.price,
          rsi_14: Number(rsi.toFixed(2)),
          sma_20: Number(sma20.toFixed(2)),
          ema_9: Number(ema9.toFixed(2)),
          recent_returns_pct: recentReturns.map((r) => Number(r.toFixed(3))),
        }
      : {
          symbol: position?.symbol,
          current_price: price,
          rsi_14: Number(rsi.toFixed(2)),
          sma_20: Number(sma20.toFixed(2)),
          ema_9: Number(ema9.toFixed(2)),
          recent_returns_pct: recentReturns.map((r) => Number(r.toFixed(3))),
        };

    const signalPayload = signal
      ? {
          type: signal.type,
          direction: signal.direction,
          value: signal.value,
          threshold: signal.threshold,
        }
      : null;

    const contextCandles = candlesForContext ?? marketData?.candles ?? [];
    const candleHistory = this.buildCandleHistory(contextCandles);

    const suggestedPlanPayload =
      suggestedEntryPlan && !position
        ? {
            entryPrice: suggestedEntryPlan.entryPrice,
            targetPrice: suggestedEntryPlan.targetPrice,
            stopLoss: suggestedEntryPlan.stopLoss,
          }
        : null;

    const positionState = position
      ? {
          symbol: position.symbol,
          side: position.side,
          entry_price: position.entryPrice,
          current_price: price,
          quantity: position.quantity,
          gross_pnl_pct: Number(
            (((price - position.entryPrice) / position.entryPrice) * 100).toFixed(2),
          ),
          net_pnl_pct: Number(
            (
              ((price - position.entryPrice) / position.entryPrice) * 100 -
              roundTripFee * 100
            ).toFixed(2),
          ),
          holding_time_min: Math.floor((Date.now() - position.timestamp) / 60000),
        }
      : null;

    const portfolioState = {
      total_equity_krw: portfolio.totalEquityKrw,
      cash_krw: portfolio.cashKrw,
      exposure_pct:
        portfolio.totalEquityKrw > 0
          ? Number(
              (
                ((portfolio.totalEquityKrw - portfolio.cashKrw) / portfolio.totalEquityKrw) *
                100
              ).toFixed(1),
            )
          : 0,
      realized_pnl_today_pct: Number((portfolio.realizedPnlTodayPct * 100).toFixed(2)),
      position_count: portfolio.positions.length,
      holdings: portfolio.positions.map((p) => {
        const currentValue = p.quantity * (p.entryPrice + (p.unrealizedPnl ?? 0) / p.quantity);
        const entryValue = p.quantity * p.entryPrice;
        const pnlPct = entryValue > 0 ? ((currentValue - entryValue) / entryValue) * 100 : 0;
        return {
          symbol: p.symbol,
          side: p.side,
          entry_price: p.entryPrice,
          quantity: p.quantity,
          unrealized_pnl_krw: p.unrealizedPnl ?? 0,
          unrealized_pnl_pct: Number(pnlPct.toFixed(2)),
        };
      }),
    };

    const sentimentState = sentiment
      ? { fear_greed_value: sentiment.fearGreedValue, fear_greed_class: sentiment.fearGreedClass }
      : null;

    const historyState =
      recentDecisions && recentDecisions.length > 0
        ? recentDecisions.slice(0, 20).map((d) => ({
            time: new Date(d.timestamp).toISOString().slice(11, 19),
            action: d.action,
            price: d.price,
            confidence: d.confidence,
            result: d.result ?? 'PENDING',
          }))
        : [];

    return `You are a unified crypto trading AI.

CONTEXT:
- Timeframe: 5-minutes candles (Breakout Retest strategy)
- Exchange: Upbit, spot, 1x (no leverage)
- LONG only (buy then sell). SHORT is NOT allowed.
- Fee: ${(feeRate * 100).toFixed(3)}% per trade (~${(roundTripFee * 100).toFixed(2)}% round-trip)

CURRENT MODE: ${tradeMode}

MARKET SENTIMENT:
${sentimentState ? `Fear & Greed Index: ${sentimentState.fear_greed_value} (${sentimentState.fear_greed_class})` : 'N/A'}
- 0-24: Extreme Fear (potential buying opportunity)
- 25-49: Fear
- 50-74: Greed
- 75-100: Extreme Greed (potential selling opportunity)

RECENT DECISIONS (last 20):
${historyState.length > 0 ? JSON.stringify(historyState, null, 2) : 'No history'}

STATE:
{
  "trade_mode": "${tradeMode}",
  "market": ${JSON.stringify(marketState)},
  "signal": ${JSON.stringify(signalPayload)},
  "candle_history": ${JSON.stringify(candleHistory)},
  "suggested_entry_plan": ${JSON.stringify(suggestedPlanPayload)},
  "position": ${JSON.stringify(positionState)},
  "portfolio": ${JSON.stringify(portfolioState)},
  "sentiment": ${JSON.stringify(sentimentState)}
}

ACTIONS:
- BUY: Open new LONG position
- SELL: Close existing LONG position
- HOLD: Keep current state (do nothing)
- SKIP: Explicitly pass (same as HOLD)

DECISION LOGIC:
- If no position exists: consider BUY or SKIP
- If position exists: consider SELL or HOLD
- BUY when you see positive expected value after fees
- SELL when:
  * RSI > 80 (overbought)
  * net_pnl_pct < -1.5% (cut loss)
  * 3+ consecutive negative returns
  * holding > 60min with no progress
- HOLD/SKIP when edge is unclear

PRICES (for BUY):
- entryPrice: near current_price
- targetPrice: take profit level
- stopLoss: cut loss level
- Must satisfy: stopLoss < entryPrice < targetPrice

OUTPUT (JSON only):
{
  "trade_mode": "${tradeMode}",
  "action": "BUY" | "SELL" | "HOLD" | "SKIP",
  "confidence": 0-100,
  "entryPrice": number | null,
  "targetPrice": number | null,
  "stopLoss": number | null,
  "suggestedExitPrice": number | null,
  "reasoning": "short explanation"
}`;
  }

  private clamp(value: unknown, min: number, max: number): number {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return min;
    return Math.min(max, Math.max(min, num));
  }

  private buildCandleHistory(candles: Candle[]): Array<{
    t: string;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
  }> {
    if (!candles || candles.length === 0) return [];

    const candleMinutes = Number(GLOBAL_CONFIG.candleMinutes) || 60;
    const perDay = Math.max(1, Math.floor((24 * 60) / candleMinutes));
    const desired = Math.max(50, Math.floor(this.candleContextDays * perDay));
    const cap = 800; // 토큰 폭주 방지 (60m 기준 30일=720)
    const take = Math.min(candles.length, Math.min(desired, cap));

    const slice = candles.slice(-take);
    return slice.map((c) => ({
      t: new Date(c.timestamp).toISOString().slice(0, 16), // YYYY-MM-DDTHH:MM
      o: Number(c.open.toFixed(4)),
      h: Number(c.high.toFixed(4)),
      l: Number(c.low.toFixed(4)),
      c: Number(c.close.toFixed(4)),
      v: Number(c.volume.toFixed(4)),
    }));
  }
}
