import { Candle, MarketData, BotConfig, OrderBook } from '../types';
import { GLOBAL_CONFIG } from '../config/config';
import {
  UpbitMarket,
  GetMarketsParams,
  UpbitCandle,
  UpbitMinuteCandle,
  UpbitDayCandle,
  UpbitWeekCandle,
  GetSecondsCanldlesParams,
  GetMinutesCandlesParams,
  GetDaysCandlesParams,
  GetWeeksCandlesParams,
  UpbitTrade,
  GetTradesParams,
  UpbitTicker,
  GetTickerParams,
  GetAllTickersParams,
  UpbitOrderbook,
  GetOrderbookParams,
  CandleUnit,
} from '../models/upbit';

export class MarketDataService {
  private readonly baseUrl = 'https://api.upbit.com/v1';
  private readonly apiMaxCount = 200;
  private candles: Candle[] = [];
  private currentPrice = 0;
  private readonly maxCandles = 10000;
  private readonly symbol: string;
  private requestChain: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private readonly minRequestIntervalMs = 80;

  public constructor(
    private readonly config: BotConfig,
    symbol?: string,
  ) {
    this.symbol = symbol || config.symbols[0] || 'KRW-BTC';
  }

  public async fetchLatestData(): Promise<MarketData> {
    const [candles, ticker, orderbook] = await Promise.all([
      this.fetchMinutesCandlesPaginated(
        this.symbol,
        GLOBAL_CONFIG.candleMinutes as CandleUnit,
        this.maxCandles,
      ),
      this.getTicker({ markets: [this.symbol] }),
      this.getOrderbook({ markets: [this.symbol] }),
    ]);

    const mappedCandles = this.mapCandles(candles);
    const price = ticker.length > 0 ? ticker[0].trade_price : 0;

    this.candles = mappedCandles;
    this.currentPrice = price;

    return {
      symbol: this.symbol,
      price,
      timestamp: Date.now(),
      candles: mappedCandles,
      orderBook: orderbook.length > 0 ? this.mapOrderbook(orderbook[0]) : undefined,
    };
  }

  private async fetchMinutesCandlesPaginated(
    market: string,
    unit: CandleUnit,
    totalCount: number,
  ): Promise<UpbitMinuteCandle[]> {
    const allCandles: UpbitMinuteCandle[] = [];
    let to: string | undefined;

    while (allCandles.length < totalCount) {
      const remaining = totalCount - allCandles.length;
      const count = Math.min(remaining, this.apiMaxCount);

      const candles = await this.getMinutesCandles({ market, unit, count, to });
      if (candles.length === 0) break;

      allCandles.push(...candles);
      to = candles[candles.length - 1].candle_date_time_utc;

      if (candles.length < count) break;
      if (allCandles.length < totalCount) await this.delay(100);
    }

    return allCandles;
  }

  public async fetchCandlesPaginated(
    market: string,
    type: 'minutes' | 'days',
    totalCount: number,
    unit: CandleUnit = GLOBAL_CONFIG.candleMinutes as CandleUnit,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<Candle[]> {
    const allCandles: Candle[] = [];
    let to: string | undefined;
    const startTime = Date.now();

    while (allCandles.length < totalCount) {
      const remaining = totalCount - allCandles.length;
      const count = Math.min(remaining, this.apiMaxCount);

      if (type === 'days') {
        const candles = await this.getDaysCandles({ market, count, to });
        if (candles.length === 0) break;

        for (const c of candles) {
          allCandles.push({
            timestamp: c.timestamp,
            open: c.opening_price,
            high: c.high_price,
            low: c.low_price,
            close: c.trade_price,
            volume: c.candle_acc_trade_volume,
          });
        }
        to = candles[candles.length - 1].candle_date_time_utc;
      } else {
        const candles = await this.getMinutesCandles({ market, unit, count, to });
        if (candles.length === 0) break;

        for (const c of candles) {
          allCandles.push({
            timestamp: c.timestamp,
            open: c.opening_price,
            high: c.high_price,
            low: c.low_price,
            close: c.trade_price,
            volume: c.candle_acc_trade_volume,
          });
        }
        to = candles[candles.length - 1].candle_date_time_utc;
      }

      if (onProgress) onProgress(allCandles.length, totalCount);
      if (allCandles.length < totalCount) await this.delay(100);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   Loaded ${allCandles.length.toLocaleString()} candles in ${elapsed}s`);

    return allCandles.reverse();
  }

  public static createSimple(symbol: string): MarketDataService {
    return new MarketDataService(
      {
        symbols: [symbol],
        intervalMs: 5000,
        cooldownMs: 60000,
        riskLimits: {
          maxPositionSizeRatio: 0.1,
          maxDailyLossRatio: 0.05,
          maxDailyTrades: 10,
          stopLossRatio: 0.02,
          takeProfitRatio: 0.04,
          maxDrawdownRatio: 0.05,
        },
        volatilityThresholds: {
          atrMultiplier: 1.2,
          priceSurgePct: 0.005,
          volumeSpikeMultiplier: 1.5,
        },
        deepseekApiKey: '',
        exchangeApiKey: '',
        exchangeSecretKey: '',
      },
      symbol,
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public async getMarkets(params: GetMarketsParams = {}): Promise<UpbitMarket[]> {
    const query = params.isDetails ? '?isDetails=true' : '';
    return this.request<UpbitMarket[]>(`/market/all${query}`);
  }

  public async getSecondsCandles(params: GetSecondsCanldlesParams): Promise<UpbitCandle[]> {
    const query = this.buildQuery(params);
    return this.request<UpbitCandle[]>(`/candles/seconds${query}`);
  }

  public async getMinutesCandles(params: GetMinutesCandlesParams): Promise<UpbitMinuteCandle[]> {
    const { unit, ...rest } = params;
    const query = this.buildQuery(rest);
    return this.request<UpbitMinuteCandle[]>(`/candles/minutes/${unit}${query}`);
  }

  public async getDaysCandles(params: GetDaysCandlesParams): Promise<UpbitDayCandle[]> {
    const query = this.buildQuery(params);
    return this.request<UpbitDayCandle[]>(`/candles/days${query}`);
  }

  public async getWeeksCandles(params: GetWeeksCandlesParams): Promise<UpbitWeekCandle[]> {
    const query = this.buildQuery(params);
    return this.request<UpbitWeekCandle[]>(`/candles/weeks${query}`);
  }

  public async getTrades(params: GetTradesParams): Promise<UpbitTrade[]> {
    const query = this.buildQuery(params);
    return this.request<UpbitTrade[]>(`/trades/ticks${query}`);
  }

  public async getTicker(params: GetTickerParams): Promise<UpbitTicker[]> {
    const query = `?markets=${params.markets.join(',')}`;
    return this.request<UpbitTicker[]>(`/ticker${query}`);
  }

  public async getAllTickers(params: GetAllTickersParams): Promise<UpbitTicker[]> {
    const query = `?quote_currencies=${params.quoteCurrencies.join(',')}`;
    return this.request<UpbitTicker[]>(`/ticker/all${query}`);
  }

  public async getOrderbook(params: GetOrderbookParams): Promise<UpbitOrderbook[]> {
    let query = `?markets=${params.markets.join(',')}`;
    if (params.level) query += `&level=${params.level}`;
    return this.request<UpbitOrderbook[]>(`/orderbook${query}`);
  }

  public getCurrentPrice(): number {
    return this.currentPrice;
  }

  public getCandles(): Candle[] {
    return [...this.candles];
  }

  public getRecentCandles(count: number): Candle[] {
    return this.candles.slice(-count);
  }

  public calculateSMA(period: number): number {
    const candles = this.getRecentCandles(period);
    if (candles.length < period) return 0;
    return candles.reduce((sum, c) => sum + c.close, 0) / period;
  }

  public calculateEMA(period: number): number {
    const candles = this.getRecentCandles(period * 2);
    if (candles.length < period) return 0;

    const multiplier = 2 / (period + 1);
    let ema = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;

    for (let i = period; i < candles.length; i++) {
      ema = (candles[i].close - ema) * multiplier + ema;
    }
    return ema;
  }

  public calculateRSI(period = 14): number {
    const candles = this.getRecentCandles(period + 1);
    if (candles.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i < candles.length; i++) {
      const change = candles[i].close - candles[i - 1].close;
      if (change > 0) gains += change;
      else losses -= change;
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  private request<T>(endpoint: string): Promise<T> {
    const job = this.requestChain.then(() => this.requestWithRetry<T>(endpoint));
    this.requestChain = job.catch(() => undefined);
    return job;
  }

  private async requestWithRetry<T>(endpoint: string): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const maxAttempts = 5;
    const timeoutMs = 10_000;
    let lastErr: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.throttle();

      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          if (this.isRetryableStatus(res.status)) {
            const waitMs = this.getBackoffMs(attempt, res);
            await this.delay(waitMs);
            continue;
          }
          throw new Error(`Upbit API error: ${res.status} - ${body}`);
        }

        const data = (await res.json()) as T;
        return data;
      } catch (e) {
        lastErr = e;
        if (!this.isRetryableError(e)) break;
        const waitMs = this.getBackoffMs(attempt);
        await this.delay(waitMs);
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Upbit request failed: ${String(lastErr)}`);
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const waitMs = this.minRequestIntervalMs - (now - this.lastRequestAt);
    if (waitMs > 0) await this.delay(waitMs);
    this.lastRequestAt = Date.now();
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || (status >= 500 && status <= 599);
  }

  private getBackoffMs(attempt: number, res?: Response): number {
    if (res && res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      const seconds = retryAfter ? Number(retryAfter) : NaN;
      if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 10_000);
    }

    const base = 200;
    const max = 5_000;
    const exp = Math.min(max, base * 2 ** attempt);
    const jitter = Math.floor(Math.random() * 100);
    return exp + jitter;
  }

  private isRetryableError(e: unknown): boolean {
    const err = e as { name?: string; message?: string; code?: string; cause?: unknown };
    const msg = `${err?.name ?? ''} ${err?.message ?? ''}`.toLowerCase();
    if (msg.includes('fetch failed')) return true;
    if (msg.includes('econnreset')) return true;
    if (msg.includes('epipe')) return true;
    if (msg.includes('und_err_socket')) return true;
    if (msg.includes('timed out') || msg.includes('timeout')) return true;

    const cause = err?.cause as { code?: string; message?: string } | undefined;
    const code = (err?.code || cause?.code || '').toString().toUpperCase();
    return (
      code === 'EPIPE' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'UND_ERR_SOCKET'
    );
  }

  private buildQuery(params: object): string {
    const entries = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);

    return entries.length > 0 ? `?${entries.join('&')}` : '';
  }

  private mapCandles(upbitCandles: UpbitMinuteCandle[]): Candle[] {
    return upbitCandles
      .map((c) => ({
        timestamp: c.timestamp,
        open: c.opening_price,
        high: c.high_price,
        low: c.low_price,
        close: c.trade_price,
        volume: c.candle_acc_trade_volume,
      }))
      .reverse();
  }

  private mapOrderbook(upbitOrderbook: UpbitOrderbook): OrderBook {
    return {
      bids: upbitOrderbook.orderbook_units.map((u) => [u.bid_price, u.bid_size]),
      asks: upbitOrderbook.orderbook_units.map((u) => [u.ask_price, u.ask_size]),
    };
  }

  public async getMicrostructure(symbol: string): Promise<MicrostructureData> {
    const [ticker, orderbook] = await Promise.all([
      this.getTicker({ markets: [symbol] }),
      this.getOrderbook({ markets: [symbol] }),
    ]);

    const t = ticker[0];
    const ob = orderbook[0];

    const bestAsk = ob.orderbook_units[0]?.ask_price ?? 0;
    const bestBid = ob.orderbook_units[0]?.bid_price ?? 0;
    const midPrice = (bestAsk + bestBid) / 2;
    const spreadPct = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 100 : 999;

    let topBookKrw = 0;
    for (const u of ob.orderbook_units.slice(0, 5)) {
      topBookKrw += u.bid_price * u.bid_size;
      topBookKrw += u.ask_price * u.ask_size;
    }

    return {
      symbol,
      price: t.trade_price,
      volume24hKrw: t.acc_trade_price_24h,
      spreadPct,
      topBookKrw,
      bestBid,
      bestAsk,
      timestamp: Date.now(),
    };
  }
}

export interface MicrostructureData {
  symbol: string;
  price: number;
  volume24hKrw: number;
  spreadPct: number;
  topBookKrw: number;
  bestBid: number;
  bestAsk: number;
  timestamp: number;
}
