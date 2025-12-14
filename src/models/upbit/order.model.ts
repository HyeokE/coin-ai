export type UpbitOrderSide = 'bid' | 'ask';
export type UpbitOrderType = 'limit' | 'price' | 'market' | 'best';
export type UpbitOrderState = 'wait' | 'watch' | 'done' | 'cancel';
export type UpbitTimeInForce = 'ioc' | 'fok';

export interface UpbitOrder {
  uuid: string;
  side: UpbitOrderSide;
  ord_type: UpbitOrderType;
  price: string | null;
  state: UpbitOrderState;
  market: string;
  created_at: string;
  volume: string | null;
  remaining_volume: string | null;
  reserved_fee: string;
  remaining_fee: string;
  paid_fee: string;
  locked: string;
  executed_volume: string;
  trades_count: number;
  trades?: UpbitOrderTrade[];
}

export interface UpbitOrderTrade {
  market: string;
  uuid: string;
  price: string;
  volume: string;
  funds: string;
  side: UpbitOrderSide;
  created_at: string;
}

export interface CreateOrderParams {
  market: string;
  side: UpbitOrderSide;
  volume?: string;
  price?: string;
  ord_type: UpbitOrderType;
  identifier?: string;
  time_in_force?: UpbitTimeInForce;
}

export interface CreateOrderResponse {
  uuid: string;
  side: UpbitOrderSide;
  ord_type: UpbitOrderType;
  price: string | null;
  state: UpbitOrderState;
  market: string;
  created_at: string;
  volume: string | null;
  remaining_volume: string | null;
  reserved_fee: string;
  remaining_fee: string;
  paid_fee: string;
  locked: string;
  executed_volume: string;
  executed_funds: string;
  trades_count: number;
  time_in_force?: UpbitTimeInForce;
}

export interface GetOrderParams {
  uuid?: string;
  identifier?: string;
}

export interface GetOrdersByUuidsParams {
  uuids?: string[];
  identifiers?: string[];
  order_by?: 'asc' | 'desc';
}

export interface GetOpenOrdersParams {
  market?: string;
  state?: UpbitOrderState;
  states?: UpbitOrderState[];
  page?: number;
  limit?: number;
  order_by?: 'asc' | 'desc';
}

export interface GetClosedOrdersParams {
  market?: string;
  state?: UpbitOrderState;
  states?: UpbitOrderState[];
  start_time?: string;
  end_time?: string;
  limit?: number;
  order_by?: 'asc' | 'desc';
}

export interface CancelOrderParams {
  uuid?: string;
  identifier?: string;
}

export interface CancelOrdersByUuidsParams {
  uuids?: string[];
  identifiers?: string[];
}

export interface BatchCancelOrdersParams {
  market?: string;
  side?: UpbitOrderSide;
  ord_types?: UpbitOrderType[];
  exclude_uuids?: string[];
  count?: number;
}

export interface BatchCancelOrdersResponse {
  success_count: number;
  fail_count: number;
  fail_uuids: string[];
  fail_identifiers: string[];
}

export interface CancelAndNewOrderParams {
  prev_order_uuid?: string;
  prev_order_identifier?: string;
  market: string;
  side: UpbitOrderSide;
  volume?: string;
  price?: string;
  ord_type: UpbitOrderType;
  identifier?: string;
  time_in_force?: UpbitTimeInForce;
}

export interface CancelAndNewOrderResponse {
  prev_order: UpbitOrder;
  new_order: CreateOrderResponse;
}

