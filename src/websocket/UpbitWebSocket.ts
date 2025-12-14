import crypto from 'crypto';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { BotConfig } from '../types';
import { GLOBAL_CONFIG } from '../config/config';

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
  ask_bid: 'ASK' | 'BID';
  order_type: string;
  state: string;
  price: number;
  volume: number;
  remaining_volume: number;
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
  currency_code: string;
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
  private publicReconnectAttempts = 0;
  private privateReconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly reconnectDelay = 3000;
  private isReconnectingPublic = false;
  private isReconnectingPrivate = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private tickerCache: Map<string, TickerData> = new Map();
  private orderbookCache: Map<string, OrderbookData> = new Map();
  private candleCache: Map<string, CandleData> = new Map();
  private lastTickerLog: Map<string, number> = new Map();
  private verbose = false;
  private tickerLogIntervalMs = 60_000; // 10초마다 ticker 로그

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
    this.isReconnectingPublic = false;
    this.isReconnectingPrivate = false;
    this.publicWs?.removeAllListeners();
    this.privateWs?.removeAllListeners();
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
        // 기존 연결이 있으면 정리
        if (this.publicWs) {
          this.publicWs.removeAllListeners();
          this.publicWs.close();
        }

        this.publicWs = new WebSocket('wss://api.upbit.com/websocket/v1');

        this.publicWs.on('open', () => {
          console.log('📡 Public WebSocket connected');
          this.subscribePublic();
          this.startPing();
          this.publicReconnectAttempts = 0;
          this.isReconnectingPublic = false;
          resolve();
        });

        this.publicWs.on('message', (data: WebSocket.Data) => {
          this.handlePublicMessage(data);
        });

        this.publicWs.on('error', (error) => {
          console.error('Public WebSocket error:', error);
          // 재연결 중이 아닐 때만 reject (재연결 중이면 close 핸들러가 처리)
          if (!this.isReconnectingPublic) {
            reject(error);
          }
        });

        this.publicWs.on('close', () => {
          // 재연결 중이 아닐 때만 handlePublicClose 호출
          if (!this.isReconnectingPublic) {
            this.handlePublicClose();
          }
        });
      } catch (error) {
        this.isReconnectingPublic = false;
        reject(error);
      }
    });
  }

  private async connectPrivate(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // 기존 연결이 있으면 정리
        if (this.privateWs) {
          this.privateWs.removeAllListeners();
          this.privateWs.close();
        }

        const token = this.createJWT();
        this.privateWs = new WebSocket('wss://api.upbit.com/websocket/v1/private', {
          headers: { Authorization: `Bearer ${token}` },
        });

        this.privateWs.on('open', () => {
          console.log('🔐 Private WebSocket connected');
          this.subscribePrivate();
          this.privateReconnectAttempts = 0;
          this.isReconnectingPrivate = false;
          resolve();
        });

        this.privateWs.on('message', (data: WebSocket.Data) => {
          this.handlePrivateMessage(data);
        });

        this.privateWs.on('error', (error) => {
          console.error('Private WebSocket error:', error);
          // 재연결 중이 아닐 때만 reject (재연결 중이면 close 핸들러가 처리)
          if (!this.isReconnectingPrivate) {
            reject(error);
          }
        });

        this.privateWs.on('close', () => {
          // 재연결 중이 아닐 때만 handlePrivateClose 호출
          if (!this.isReconnectingPrivate) {
            this.handlePrivateClose();
          }
        });
      } catch (error) {
        this.isReconnectingPrivate = false;
        reject(error);
      }
    });
  }

  private subscribePublic(): void {
    if (!this.publicWs || this.publicWs.readyState !== WebSocket.OPEN) return;

    const symbols = this.config.symbols;
    const candleMinutes = GLOBAL_CONFIG.candleMinutes;

    const subscribeMsg = [
      { ticket: `auto-coin-${Date.now()}` },
      { type: 'ticker', codes: symbols, isOnlyRealtime: true },
      { type: 'orderbook', codes: symbols, isOnlyRealtime: true },
      { type: 'trade', codes: symbols, isOnlyRealtime: true },
      { type: `candle.${candleMinutes}m`, codes: symbols, isOnlyRealtime: true },
    ];

    this.publicWs.send(JSON.stringify(subscribeMsg));
    console.log(`📊 Subscribed: ticker, orderbook, trade, candle.${candleMinutes}m`);
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

  private async handlePublicMessage(data: WebSocket.Data): Promise<void> {
    try {
      const text = data instanceof Buffer ? data.toString('utf-8') : String(data);
      const parsed = JSON.parse(text);

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
        // console.log(
        //   `🕯️ [CANDLE] ${candle.code}: O=${candle.opening_price.toLocaleString()} H=${candle.high_price.toLocaleString()} L=${candle.low_price.toLocaleString()} C=${candle.trade_price.toLocaleString()}`,
        // );
      }
    } catch (error) {
      console.error('Failed to parse public message:', error);
    }
  }

  private async handlePrivateMessage(data: WebSocket.Data): Promise<void> {
    try {
      const text = data instanceof Buffer ? data.toString('utf-8') : String(data);
      const parsed = JSON.parse(text);

      if (parsed.type === 'myOrder') {
        const order = parsed as MyOrderData;
        this.emit('myOrder', order);
        const side = order.ask_bid === 'BID' ? '🟢매수' : '🔴매도';
        console.log(
          `📬 [MY_ORDER] ${order.code}: ${side} ${order.state} | 가격=${order.price?.toLocaleString()} 수량=${order.volume} 체결=${order.executed_volume}`,
        );
      } else if (parsed.type === 'myAsset') {
        const asset = parsed as MyAssetData;
        this.emit('myAsset', asset);
        console.log(
          `💰 [MY_ASSET] ${asset.currency_code}: 잔고=${asset.balance} 잠금=${asset.locked} 평단=${asset.avg_buy_price}`,
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
    // 이미 재연결 중이면 무시
    if (type === 'public' && this.isReconnectingPublic) return;
    if (type === 'private' && this.isReconnectingPrivate) return;

    const attempts =
      type === 'public' ? this.publicReconnectAttempts : this.privateReconnectAttempts;

    if (attempts >= this.maxReconnectAttempts) {
      console.error(`Max reconnect attempts reached for ${type} WebSocket`);
      console.error(`🔄 Restarting server to recover WebSocket connection...`);
      this.emit('error', new Error(`Failed to reconnect ${type} WebSocket`));
      // 프로세스 매니저가 자동으로 재시작하도록 프로세스 종료
      setTimeout(() => {
        process.exit(1);
      }, 1000); // 1초 후 종료하여 로그가 출력될 시간 확보
      return;
    }

    // 재연결 시도 카운터 증가
    if (type === 'public') {
      this.publicReconnectAttempts++;
      this.isReconnectingPublic = true;
    } else {
      this.privateReconnectAttempts++;
      this.isReconnectingPrivate = true;
    }

    const delay = this.reconnectDelay * Math.min(attempts + 1, 5);
    console.log(
      `Reconnecting ${type} WebSocket in ${delay}ms (attempt ${attempts + 1}/${this.maxReconnectAttempts})`,
    );

    setTimeout(async () => {
      try {
        if (type === 'public') {
          await this.connectPublic();
        } else {
          await this.connectPrivate();
        }
      } catch (error) {
        console.error(`Reconnect failed for ${type}:`, error);
        // 재연결 실패 시 플래그 해제하여 다시 시도할 수 있도록 함
        if (type === 'public') {
          this.isReconnectingPublic = false;
        } else {
          this.isReconnectingPrivate = false;
        }
        // 실패해도 다시 scheduleReconnect를 호출하지 않음 (무한 루프 방지)
        // 대신 다음 close 이벤트에서 다시 시도됨
      }
    }, delay);
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.publicWs?.readyState === WebSocket.OPEN) {
        this.publicWs.ping();
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
