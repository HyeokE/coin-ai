import { TradeSide } from '../types';

export interface DecisionLog {
  id?: string;
  created_at?: string;
  symbol: string;
  signal_type: string;
  signal_direction: string;
  should_trade: boolean;
  side: TradeSide | null;
  confidence: number;
  reasoning: string;
  current_price: number;
  rsi: number;
  sma20: number;
  ema9: number;
}

export interface PositionEvalLog {
  id?: string;
  created_at?: string;
  symbol: string;
  action: 'HOLD' | 'CLOSE' | 'TRIM_HALF';
  confidence: number;
  reasoning: string;
  current_price: number;
  entry_price: number;
  gross_pnl_pct: number;
  net_pnl_pct: number;
  holding_time_min: number;
  rsi: number;
  sma20: number;
  ema9: number;
}

export interface TradeLog {
  id?: string;
  created_at?: string;
  symbol: string;
  side: TradeSide;
  action: 'OPEN' | 'CLOSE' | 'TRIM';
  price: number;
  quantity: number;
  order_id: string;
  pnl?: number;
  pnl_percent?: number;
  exit_reason?: string;
}
