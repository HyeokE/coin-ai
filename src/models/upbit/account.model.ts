export interface UpbitAccount {
  currency: string;
  balance: string;
  locked: string;
  avg_buy_price: string;
  avg_buy_price_modified: boolean;
  unit_currency: string;
}

export interface UpbitOrderChance {
  bid_fee: string;
  ask_fee: string;
  market: UpbitOrderChanceMarket;
  bid_account: UpbitOrderChanceAccount;
  ask_account: UpbitOrderChanceAccount;
  maker_bid_fee: string;
  maker_ask_fee: string;
}

export interface UpbitOrderChanceMarket {
  id: string;
  name: string;
  order_types: string[];
  ask_types: string[];
  bid_types: string[];
  order_sides: string[];
  bid: UpbitOrderChanceConstraint;
  ask: UpbitOrderChanceConstraint;
  max_total: string;
  state: string;
}

export interface UpbitOrderChanceConstraint {
  currency: string;
  price_unit?: string;
  min_total: string;
}

export interface UpbitOrderChanceAccount {
  currency: string;
  balance: string;
  locked: string;
  avg_buy_price: string;
  avg_buy_price_modified: boolean;
  unit_currency: string;
}

export interface GetOrderChanceParams {
  market: string;
}

