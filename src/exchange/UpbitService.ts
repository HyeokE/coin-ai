import crypto from 'crypto';
import {
  UpbitAccount,
  UpbitOrderChance,
  GetOrderChanceParams,
  UpbitOrder,
  CreateOrderParams,
  CreateOrderResponse,
  GetOrderParams,
  GetOrdersByUuidsParams,
  GetOpenOrdersParams,
  GetClosedOrdersParams,
  CancelOrderParams,
  CancelOrdersByUuidsParams,
  BatchCancelOrdersParams,
  BatchCancelOrdersResponse,
  CancelAndNewOrderParams,
  CancelAndNewOrderResponse,
} from '../models/upbit';
import { BotConfig, Position, Order, TradeSide, OrderType } from '../types';

export class UpbitService {
  private readonly baseUrl = 'https://api.upbit.com/v1';
  private currentPosition: Position | null = null;

  public constructor(private readonly config: BotConfig) {}

  public async getAccounts(): Promise<UpbitAccount[]> {
    return this.authRequest<UpbitAccount[]>('GET', '/accounts');
  }

  public async getBalance(currency = 'KRW'): Promise<number> {
    const accounts = await this.getAccounts();
    const account = accounts.find((a) => a.currency === currency);
    return account ? parseFloat(account.balance) : 0;
  }

  public async getOrderChance(params: GetOrderChanceParams): Promise<UpbitOrderChance> {
    return this.authRequest<UpbitOrderChance>('GET', '/orders/chance', params);
  }

  public async createOrder(params: CreateOrderParams): Promise<CreateOrderResponse> {
    return this.authRequest<CreateOrderResponse>('POST', '/orders', params);
  }

  public async testOrder(params: CreateOrderParams): Promise<CreateOrderResponse> {
    return this.authRequest<CreateOrderResponse>('POST', '/orders/test', params);
  }

  public async getOrder(params: GetOrderParams): Promise<UpbitOrder> {
    return this.authRequest<UpbitOrder>('GET', '/order', params);
  }

  public async getOrdersByUuids(params: GetOrdersByUuidsParams): Promise<UpbitOrder[]> {
    const queryParams = this.buildArrayParams(params);
    return this.authRequest<UpbitOrder[]>('GET', '/orders/uuids', queryParams);
  }

  public async getOpenOrders(params: GetOpenOrdersParams = {}): Promise<UpbitOrder[]> {
    const queryParams = this.buildArrayParams(params);
    return this.authRequest<UpbitOrder[]>('GET', '/orders/open', queryParams);
  }

  public async getClosedOrders(params: GetClosedOrdersParams = {}): Promise<UpbitOrder[]> {
    const queryParams = this.buildArrayParams(params);
    return this.authRequest<UpbitOrder[]>('GET', '/orders/closed', queryParams);
  }

  public async cancelOrder(params: CancelOrderParams): Promise<UpbitOrder> {
    return this.authRequest<UpbitOrder>('DELETE', '/order', params);
  }

  public async cancelOrdersByUuids(params: CancelOrdersByUuidsParams): Promise<UpbitOrder[]> {
    const queryParams = this.buildArrayParams(params);
    return this.authRequest<UpbitOrder[]>('DELETE', '/orders/uuids', queryParams);
  }

  public async batchCancelOrders(
    params: BatchCancelOrdersParams,
  ): Promise<BatchCancelOrdersResponse> {
    const queryParams = this.buildArrayParams(params);
    return this.authRequest<BatchCancelOrdersResponse>('DELETE', '/orders', queryParams);
  }

  public async cancelAndNewOrder(
    params: CancelAndNewOrderParams,
  ): Promise<CancelAndNewOrderResponse> {
    return this.authRequest<CancelAndNewOrderResponse>('POST', '/order/cancel_and_new', params);
  }

  public async openPosition(
    side: TradeSide,
    quantity: number,
    price?: number,
    symbol?: string,
  ): Promise<Order> {
    const market = symbol || this.config.symbols[0];
    const upbitSide = side === TradeSide.LONG ? 'bid' : 'ask';
    const ordType = price ? 'limit' : side === TradeSide.LONG ? 'price' : 'market';

    const params: CreateOrderParams = {
      market,
      side: upbitSide,
      ord_type: ordType,
    };

    if (ordType === 'limit') {
      params.volume = quantity.toString();
      params.price = price!.toString();
    } else if (ordType === 'price') {
      params.price = (quantity * (price || 0)).toString();
    } else {
      params.volume = quantity.toString();
    }

    const response = await this.createOrder(params);

    const order: Order = {
      id: response.uuid,
      symbol: market,
      side,
      type: price ? OrderType.LIMIT : OrderType.MARKET,
      price: response.price ? parseFloat(response.price) : undefined,
      quantity: parseFloat(response.executed_volume),
      status: this.mapOrderState(response.state),
      timestamp: Date.now(),
    };

    if (order.status === 'FILLED' && parseFloat(response.executed_volume) > 0) {
      const avgPrice = parseFloat(response.executed_funds) / parseFloat(response.executed_volume);
      this.currentPosition = {
        symbol: market,
        side,
        entryPrice: avgPrice,
        quantity: parseFloat(response.executed_volume),
        timestamp: Date.now(),
        unrealizedPnl: 0,
      };
    }

    return order;
  }

  public async closePosition(currentPrice: number): Promise<Order | null> {
    if (!this.currentPosition) return null;

    const closeSide =
      this.currentPosition.side === TradeSide.LONG ? TradeSide.SHORT : TradeSide.LONG;
    const order = await this.openPosition(closeSide, this.currentPosition.quantity, currentPrice);

    if (order.status === 'FILLED') {
      console.log(`Position closed at ${currentPrice}`);
      this.currentPosition = null;
    }

    return order;
  }

  public getCurrentPosition(): Position | null {
    return this.currentPosition;
  }

  public updatePositionPnl(currentPrice: number): void {
    if (!this.currentPosition) return;

    const direction = this.currentPosition.side === TradeSide.LONG ? 1 : -1;
    this.currentPosition.unrealizedPnl =
      ((currentPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice) *
      100 *
      direction;
  }

  private async authRequest<T>(method: string, endpoint: string, params: object = {}): Promise<T> {
    const token = this.createJWT(params);
    const url = this.buildUrl(endpoint, method === 'GET' || method === 'DELETE' ? params : {});

    const options: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };

    if (method === 'POST' && Object.keys(params).length > 0) {
      options.body = JSON.stringify(params);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Upbit API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<T>;
  }

  private createJWT(params: object): string {
    const payload: Record<string, string> = {
      access_key: this.config.exchangeApiKey,
      nonce: crypto.randomUUID(),
    };

    if (Object.keys(params).length > 0) {
      const query = this.buildQueryString(params as Record<string, unknown>);
      const hash = crypto.createHash('sha512').update(query, 'utf-8').digest('hex');
      payload.query_hash = hash;
      payload.query_hash_alg = 'SHA512';
    }

    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.config.exchangeSecretKey)
      .update(`${header}.${payloadB64}`)
      .digest('base64url');

    return `${header}.${payloadB64}.${signature}`;
  }

  private buildUrl(endpoint: string, params: object): string {
    const query = this.buildQueryString(params as Record<string, unknown>);
    return query ? `${this.baseUrl}${endpoint}?${query}` : `${this.baseUrl}${endpoint}`;
  }

  private buildQueryString(params: Record<string, unknown>): string {
    const entries: string[] = [];

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;

      if (Array.isArray(value)) {
        value.forEach((v) => entries.push(`${key}[]=${encodeURIComponent(String(v))}`));
      } else {
        entries.push(`${key}=${encodeURIComponent(String(value))}`);
      }
    }

    return entries.join('&');
  }

  private buildArrayParams(params: object): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      result[key] = value;
    }

    return result;
  }

  private mapOrderState(state: string): 'PENDING' | 'FILLED' | 'CANCELLED' | 'FAILED' {
    switch (state) {
      case 'done':
        return 'FILLED';
      case 'wait':
      case 'watch':
        return 'PENDING';
      case 'cancel':
        return 'CANCELLED';
      default:
        return 'FAILED';
    }
  }
}
