export interface UpbitCandle {
  market: string;
  candle_date_time_utc: string;
  candle_date_time_kst: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  timestamp: number;
  candle_acc_trade_price: number;
  candle_acc_trade_volume: number;
}

export interface UpbitMinuteCandle extends UpbitCandle {
  unit: number;
}

export interface UpbitDayCandle extends UpbitCandle {
  prev_closing_price: number;
  change_price: number;
  change_rate: number;
  converted_trade_price?: number;
}

export interface UpbitWeekCandle extends UpbitCandle {
  first_day_of_period: string;
}

export type CandleUnit = 1 | 3 | 5 | 15 | 30 | 60 | 240;

export interface GetSecondsCanldlesParams {
  market: string;
  to?: string;
  count?: number;
}

export interface GetMinutesCandlesParams {
  market: string;
  unit: CandleUnit;
  to?: string;
  count?: number;
}

export interface GetDaysCandlesParams {
  market: string;
  to?: string;
  count?: number;
  convertingPriceUnit?: string;
}

export interface GetWeeksCandlesParams {
  market: string;
  to?: string;
  count?: number;
}

