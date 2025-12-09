export interface UpbitMarket {
  market: string;
  korean_name: string;
  english_name: string;
  market_event?: UpbitMarketEvent;
}

export interface UpbitMarketEvent {
  warning: boolean;
  caution?: UpbitMarketCaution;
}

export interface UpbitMarketCaution {
  PRICE_FLUCTUATIONS?: boolean;
  TRADING_VOLUME_SOARING?: boolean;
  DEPOSIT_AMOUNT_SOARING?: boolean;
  GLOBAL_PRICE_DIFFERENCES?: boolean;
  CONCENTRATION_OF_SMALL_ACCOUNTS?: boolean;
}

export interface GetMarketsParams {
  isDetails?: boolean;
}

