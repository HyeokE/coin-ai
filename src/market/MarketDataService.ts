import { Candle, MarketData, BotConfig, OrderBook } from '../types';
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
} from '../models/upbit';

export class MarketDataService {
  private readonly baseUrl = 'https://api.upbit.com/v1';
  private candles: Candle[] = [];
  private currentPrice = 0;
  private readonly maxCandles = 200;
  private readonly symbol: string;

  public constructor(
    private readonly config: BotConfig,
    symbol?: string,
  ) {
    this.symbol = symbol || config.symbols[0] || 'KRW-BTC';
  }

  public async fetchLatestData(): Promise<MarketData> {
    const [candles, ticker, orderbook] = await Promise.all([
      this.getMinutesCandles({ market: this.symbol, unit: 5, count: this.maxCandles }),
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

  private async request<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Upbit API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data as T;
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
}
