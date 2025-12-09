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

export interface TradeLog {
  id?: string;
  created_at?: string;
  symbol: string;
  side: TradeSide;
  action: 'OPEN' | 'CLOSE';
  price: number;
  quantity: number;
  order_id: string;
  pnl?: number;
  pnl_percent?: number;
  exit_reason?: string;
}

