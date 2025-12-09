import crypto from 'crypto';
import { EventEmitter } from 'events';
import { BotConfig } from '../types';

export interface TickerData {
  type: 'ticker';
  code: string;
  trade_price: number;
  signed_change_rate: number;
  acc_trade_volume_24h: number;
  timestamp: number;
}

export interface TradeData {
  type: 'trade';
  code: string;
  trade_price: number;
  trade_volume: number;
  ask_bid: 'ASK' | 'BID';
  timestamp: number;
}

export interface OrderbookData {
  type: 'orderbook';
  code: string;
  orderbook_units: { ask_price: number; bid_price: number; ask_size: number; bid_size: number }[];
  timestamp: number;
}

export interface MyOrderData {
  type: 'myOrder';
  code: string;
  uuid: string;
  side: 'bid' | 'ask';
  ord_type: string;
  state: string;
  price: number;
  volume: number;
  executed_volume: number;
  timestamp: number;
}

export interface CandleData {
  type: 'candle';
  code: string;
  candle_date_time_utc: string;
  candle_date_time_kst: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  candle_acc_trade_volume: number;
  unit: number;
  timestamp: number;
}

export interface MyAssetData {
  type: 'myAsset';
  currency: string;
  balance: string;
  locked: string;
  avg_buy_price: string;
  timestamp: number;
}

export type WebSocketMessage =
  | TickerData
  | TradeData
  | OrderbookData
  | MyOrderData
  | CandleData
  | MyAssetData;

export class UpbitWebSocket extends EventEmitter {
  private publicWs: WebSocket | null = null;
  private privateWs: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly reconnectDelay = 3000;
  private pingInterval: NodeJS.Timeout | null = null;
  private tickerCache: Map<string, TickerData> = new Map();
  private orderbookCache: Map<string, OrderbookData> = new Map();
  private candleCache: Map<string, CandleData> = new Map();
  private lastTickerLog: Map<string, number> = new Map();
  private verbose = false;
  private tickerLogIntervalMs = 10_000; // 10초마다 ticker 로그

  public constructor(private readonly config: BotConfig) {
    super();
  }

  public async connect(): Promise<void> {
    await this.connectPublic();
    if (this.config.exchangeApiKey && this.config.exchangeSecretKey) {
      await this.connectPrivate();
    }
  }

  public disconnect(): void {
    this.stopPing();
    this.publicWs?.close();
    this.privateWs?.close();
    this.publicWs = null;
    this.privateWs = null;
  }

  public getTicker(symbol: string): TickerData | undefined {
    return this.tickerCache.get(symbol);
  }

  public getOrderbook(symbol: string): OrderbookData | undefined {
    return this.orderbookCache.get(symbol);
  }

  public getCandle(symbol: string): CandleData | undefined {
    return this.candleCache.get(symbol);
  }

  public setVerbose(enabled: boolean): void {
    this.verbose = enabled;
  }

  private logTickerThrottled(ticker: TickerData): void {
    const now = Date.now();
    const lastLog = this.lastTickerLog.get(ticker.code) ?? 0;

    if (now - lastLog >= this.tickerLogIntervalMs) {
      this.lastTickerLog.set(ticker.code, now);
      console.log(
        `📈 [TICKER] ${ticker.code}: ${ticker.trade_price.toLocaleString()} (${(ticker.signed_change_rate * 100).toFixed(2)}%)`,
      );
    }
  }

  private async connectPublic(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.publicWs = new WebSocket('wss://api.upbit.com/websocket/v1');

        this.publicWs.onopen = () => {
          console.log('📡 Public WebSocket connected');
          this.subscribePublic();
          this.startPing();
          this.reconnectAttempts = 0;
          resolve();
        };

        this.publicWs.onmessage = (event) => this.handlePublicMessage(event);
        this.publicWs.onerror = (error) => {
          console.error('Public WebSocket error:', error);
          reject(error);
        };
        this.publicWs.onclose = () => this.handlePublicClose();
      } catch (error) {
        reject(error);
      }
    });
  }

  private async connectPrivate(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const token = this.createJWT();
        this.privateWs = new WebSocket('wss://api.upbit.com/websocket/v1/private', {
          headers: { Authorization: `Bearer ${token}` },
        });

        this.privateWs.onopen = () => {
          console.log('🔐 Private WebSocket connected');
          this.subscribePrivate();
          resolve();
        };

        this.privateWs.onmessage = (event) => this.handlePrivateMessage(event);
        this.privateWs.onerror = (error) => {
          console.error('Private WebSocket error:', error);
          reject(error);
        };
        this.privateWs.onclose = () => this.handlePrivateClose();
      } catch (error) {
        reject(error);
      }
    });
  }

  private subscribePublic(): void {
    if (!this.publicWs || this.publicWs.readyState !== WebSocket.OPEN) return;

    const symbols = this.config.symbols;

    const subscribeMsg = [
      { ticket: `auto-coin-${Date.now()}` },
      { type: 'ticker', codes: symbols, isOnlyRealtime: true },
      { type: 'orderbook', codes: symbols, isOnlyRealtime: true },
      { type: 'trade', codes: symbols, isOnlyRealtime: true },
      { type: 'candle.1m', codes: symbols, isOnlyRealtime: true },
    ];

    this.publicWs.send(JSON.stringify(subscribeMsg));
    console.log(`📊 Subscribed: ticker, orderbook, trade, candle.1m`);
    console.log(`   Symbols: ${symbols.join(', ')}`);
  }

  private subscribePrivate(): void {
    if (!this.privateWs || this.privateWs.readyState !== WebSocket.OPEN) return;

    const subscribeMsg = [
      { ticket: `auto-coin-private-${Date.now()}` },
      { type: 'myOrder' },
      { type: 'myAsset' },
    ];

    this.privateWs.send(JSON.stringify(subscribeMsg));
    console.log('🔔 Subscribed to myOrder, myAsset');
  }

  private async handlePublicMessage(event: MessageEvent): Promise<void> {
    try {
      const data = event.data instanceof Blob ? await event.data.text() : event.data;
      const parsed = JSON.parse(data);

      if (parsed.type === 'ticker') {
        const ticker = parsed as TickerData;
        this.tickerCache.set(ticker.code, ticker);
        this.emit('ticker', ticker);
        this.logTickerThrottled(ticker);
      } else if (parsed.type === 'orderbook') {
        const ob = parsed as OrderbookData;
        this.orderbookCache.set(ob.code, ob);
        this.emit('orderbook', ob);
        if (this.verbose && ob.orderbook_units?.[0]) {
          const best = ob.orderbook_units[0];
          console.log(
            `📊 [ORDERBOOK] ${ob.code}: 매수 ${best.bid_price.toLocaleString()} / 매도 ${best.ask_price.toLocaleString()}`,
          );
        }
      } else if (parsed.type === 'trade') {
        const trade = parsed as TradeData;
        this.emit('trade', trade);
        if (this.verbose) {
          const side = trade.ask_bid === 'BID' ? '🟢매수' : '🔴매도';
          console.log(
            `💹 [TRADE] ${trade.code}: ${side} ${trade.trade_price.toLocaleString()} x ${trade.trade_volume}`,
          );
        }
      } else if (parsed.type?.startsWith('candle.')) {
        const candle = parsed as CandleData;
        this.candleCache.set(candle.code, candle);
        this.emit('candle', candle);
        console.log(
          `🕯️ [CANDLE] ${candle.code}: O=${candle.opening_price.toLocaleString()} H=${candle.high_price.toLocaleString()} L=${candle.low_price.toLocaleString()} C=${candle.trade_price.toLocaleString()}`,
        );
      }
    } catch (error) {
      console.error('Failed to parse public message:', error);
    }
  }

  private async handlePrivateMessage(event: MessageEvent): Promise<void> {
    try {
      const data = event.data instanceof Blob ? await event.data.text() : event.data;
      const parsed = JSON.parse(data);

      if (parsed.type === 'myOrder') {
        const order = parsed as MyOrderData;
        this.emit('myOrder', order);
        const side = order.side === 'bid' ? '🟢매수' : '🔴매도';
        console.log(
          `📬 [MY_ORDER] ${order.code}: ${side} ${order.state} | 가격=${order.price?.toLocaleString()} 수량=${order.volume} 체결=${order.executed_volume}`,
        );
      } else if (parsed.type === 'myAsset') {
        const asset = parsed as MyAssetData;
        this.emit('myAsset', asset);
        console.log(
          `💰 [MY_ASSET] ${asset.currency}: 잔고=${asset.balance} 잠금=${asset.locked} 평단=${asset.avg_buy_price}`,
        );
      }
    } catch (error) {
      console.error('Failed to parse private message:', error);
    }
  }

  private handlePublicClose(): void {
    console.log('📡 Public WebSocket closed');
    this.stopPing();
    this.scheduleReconnect('public');
  }

  private handlePrivateClose(): void {
    console.log('🔐 Private WebSocket closed');
    this.scheduleReconnect('private');
  }

  private scheduleReconnect(type: 'public' | 'private'): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`Max reconnect attempts reached for ${type} WebSocket`);
      this.emit('error', new Error(`Failed to reconnect ${type} WebSocket`));
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);
    console.log(`Reconnecting ${type} WebSocket in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(async () => {
      try {
        if (type === 'public') {
          await this.connectPublic();
        } else {
          await this.connectPrivate();
        }
      } catch (error) {
        console.error(`Reconnect failed:`, error);
      }
    }, delay);
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.publicWs?.readyState === WebSocket.OPEN) {
        this.publicWs.send('PING');
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private createJWT(): string {
    const payload = {
      access_key: this.config.exchangeApiKey,
      nonce: crypto.randomUUID(),
    };

    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.config.exchangeSecretKey)
      .update(`${header}.${body}`)
      .digest('base64url');

    return `${header}.${body}.${signature}`;
  }
}
