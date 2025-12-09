import { AgentDecision, MarketData, VolatilitySignal, Position, TradeSide } from '../types';

interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DeepSeekResponse {
  choices: { message: { content: string } }[];
}

interface AgentRiskConfig {
  /** 최소 신뢰도: 이 값 미만이면 무조건 shouldTrade=false */
  minConfidence: number;
  /** SHORT 포지션 허용 여부 (현물만이면 false) */
  allowShort: boolean;
}

export class DeepSeekAgent {
  private readonly baseUrl = 'https://api.deepseek.com/v1/chat/completions';

  public constructor(
    private readonly apiKey: string,
    private readonly riskConfig: AgentRiskConfig = {
      minConfidence: 65,
      allowShort: false,
    },
  ) {}

  public async analyze(
    marketData: MarketData,
    signal: VolatilitySignal,
    currentPosition: Position | null,
    rsi: number,
    sma20: number,
    ema9: number,
  ): Promise<AgentDecision> {
    const prompt = this.buildPrompt(marketData, signal, currentPosition, rsi, sma20, ema9);

    try {
      const response = await this.callAPI(prompt);
      return this.parseResponse(response, marketData.price);
    } catch (error) {
      console.error('DeepSeek API error:', error);
      return this.createFallbackDecision('API error');
    }
  }

  private buildPrompt(
    marketData: MarketData,
    signal: VolatilitySignal,
    position: Position | null,
    rsi: number,
    sma20: number,
    ema9: number,
  ): string {
    const recentCandles = marketData.candles.slice(-10);
    const priceChanges = recentCandles.map((c, i) =>
      i === 0 ? 0 : ((c.close - recentCandles[i - 1].close) / recentCandles[i - 1].close) * 100,
    );

    // 필요하다면 여기에서 maxPositionPct, 일간 손실 한도 같은 계좌 제약도 문자열로 넣어줄 수 있음
    return `You are a crypto trading analyst. Analyze and respond in JSON only.

MARKET DATA:
- Symbol: ${marketData.symbol}
- Current Price: ${marketData.price}
- RSI(14): ${rsi.toFixed(2)}
- SMA(20): ${sma20.toFixed(2)}
- EMA(9): ${ema9.toFixed(2)}
- Recent price changes: ${priceChanges
      .slice(-5)
      .map((p) => p.toFixed(2) + '%')
      .join(', ')}

VOLATILITY SIGNAL:
- Type: ${signal.type}
- Direction: ${signal.direction}
- Value: ${signal.value.toFixed(4)}
- Threshold: ${signal.threshold.toFixed(4)}

CURRENT POSITION: ${position ? `${position.side} @ ${position.entryPrice}, PnL: ${position.unrealizedPnl.toFixed(2)}%` : 'None'}

CONSTRAINTS:
- You must respect that SHORT trades are ${this.riskConfig.allowShort ? 'allowed' : 'NOT allowed'}.
- Confidence must be between 0 and 100.
- If you are not clearly confident (below ${this.riskConfig.minConfidence}), you MUST set "shouldTrade" to false.

Respond ONLY with valid JSON in the following shape (no extra keys, no comments):

{
  "shouldTrade": true | false,
  "side": "LONG" | "SHORT" | null,
  "confidence": 0-100,
  "entryPrice": number | null,
  "targetPrice": number | null,
  "stopLoss": number | null,
  "reasoning": "brief explanation"
}`;
  }

  private async callAPI(prompt: string): Promise<string> {
    const messages: DeepSeekMessage[] = [
      {
        role: 'system',
        content:
          'You are a trading analysis AI. Respond only in valid JSON. Do not include any text outside the JSON object.',
      },
      { role: 'user', content: prompt },
    ];

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: 'json_object' }, // ★ JSON 모드
      }),
    });

    if (!response.ok) {
      throw new Error(`DeepSeek API error: ${response.status}`);
    }

    const data = (await response.json()) as DeepSeekResponse;
    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error('DeepSeek API returned empty content');
    }

    return content;
  }

  private parseResponse(response: string, currentPrice: number): AgentDecision {
    try {
      const raw = JSON.parse(response) as Partial<AgentDecision> & {
        side?: string;
      };

      const confidence = this.safeNumber(raw.confidence, 0, 100);

      // side 변환 + SHORT 허용 여부 체크
      let side: TradeSide | undefined;
      if (raw.side === 'LONG') {
        side = TradeSide.LONG;
      } else if (raw.side === 'SHORT' && this.riskConfig.allowShort) {
        side = TradeSide.SHORT;
      }

      let shouldTrade = Boolean(raw.shouldTrade);
      if (!side) {
        // side가 없으면 무조건 트레이드하지 않음
        shouldTrade = false;
      }
      if (confidence < this.riskConfig.minConfidence) {
        shouldTrade = false;
      }

      const entryPrice = this.safePositiveNumber(raw.entryPrice) ?? currentPrice;
      const targetPrice = this.safePositiveNumber(raw.targetPrice);
      const stopLoss = this.safePositiveNumber(raw.stopLoss);

      // 기본적인 가격 논리 체크 (LONG/SHORT에 따라 다른 조건)
      if (shouldTrade && side && targetPrice && stopLoss) {
        const isValid =
          side === TradeSide.LONG
            ? stopLoss < entryPrice && entryPrice < targetPrice
            : stopLoss > entryPrice && entryPrice > targetPrice;

        if (!isValid) {
          // 가격 구조가 말이 안 되면 이 트레이드는 버린다
          shouldTrade = false;
        }
      }

      if (!shouldTrade) {
        return this.createFallbackDecision(raw.reasoning || 'Trade rejected by local risk rules');
      }

      return {
        shouldTrade,
        side,
        confidence,
        entryPrice,
        targetPrice: targetPrice ?? undefined,
        stopLoss: stopLoss ?? undefined,
        reasoning: raw.reasoning || 'No reasoning provided',
      };
    } catch (e) {
      console.error('Failed to parse DeepSeek response', e);
      return this.createFallbackDecision('Invalid JSON response');
    }
  }

  private safeNumber(value: unknown, min = -Infinity, max = Infinity): number {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.min(max, Math.max(min, num));
  }

  private safePositiveNumber(value: unknown): number | undefined {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num) || num <= 0) return undefined;
    return num;
  }

  private createFallbackDecision(reason: string): AgentDecision {
    return {
      shouldTrade: false,
      confidence: 0,
      reasoning: reason,
    };
  }
}
