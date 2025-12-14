export interface UpbitOrderbook {
  market: string;
  timestamp: number;
  total_ask_size: number;
  total_bid_size: number;
  orderbook_units: UpbitOrderbookUnit[];
  level: number;
}

export interface UpbitOrderbookUnit {
  ask_price: number;
  bid_price: number;
  ask_size: number;
  bid_size: number;
}

export interface GetOrderbookParams {
  markets: string[];
  level?: number;
}

