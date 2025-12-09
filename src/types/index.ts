export enum BotState {
  IDLE = 'IDLE',
  MONITORING = 'MONITORING',
  ANALYZING = 'ANALYZING',
  TRADING = 'TRADING',
  COOLING_DOWN = 'COOLING_DOWN',
  ERROR = 'ERROR',
}

export enum TradeSide {
  LONG = 'LONG',
  SHORT = 'SHORT',
}

export enum OrderType {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
}

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketData {
  symbol: string;
  price: number;
  timestamp: number;
  candles: Candle[];
  orderBook?: OrderBook;
}

export interface OrderBook {
  bids: [number, number][];
  asks: [number, number][];
}

export interface VolatilitySignal {
  type: 'ATR_SPIKE' | 'PRICE_SURGE' | 'VOLUME_SPIKE';
  value: number;
  threshold: number;
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  timestamp: number;
  atrPercent?: number;
}

export interface AgentDecision {
  shouldTrade: boolean;
  side?: TradeSide;
  confidence: number;
  entryPrice?: number;
  targetPrice?: number;
  stopLoss?: number;
  reasoning: string;
}

export interface Position {
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  quantity: number;
  timestamp: number;
  unrealizedPnl: number;
}

export interface Order {
  id: string;
  symbol: string;
  side: TradeSide;
  type: OrderType;
  price?: number;
  quantity: number;
  status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'FAILED';
  timestamp: number;
}

export interface TradeResult {
  orderId: string;
  side: TradeSide;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  pnl?: number;
  pnlPercent?: number;
  exitReason?: 'TAKE_PROFIT' | 'STOP_LOSS' | 'MANUAL' | 'RISK_LIMIT';
}

export interface RiskLimits {
  /** 종목당 최대 포지션 비율 (0.1 = 10%) */
  maxPositionSizeRatio: number;
  /** 일일 최대 손실 비율 (0.05 = 5%) */
  maxDailyLossRatio: number;
  /** 일일 최대 거래 횟수 */
  maxDailyTrades: number;
  /** 손절 비율 (0.02 = 2%) */
  stopLossRatio: number;
  /** 익절 비율 (0.04 = 4%) */
  takeProfitRatio: number;
  /** 최대 드로다운 비율 (0.05 = 5%) */
  maxDrawdownRatio: number;
}

export interface BotConfig {
  symbols: string[];
  intervalMs: number;
  riskLimits: RiskLimits;
  volatilityThresholds: {
    atrMultiplier: number;
    priceSurgePercentValue: number;
    volumeSpikeMultiplier: number;
  };
  cooldownMs: number;
  deepseekApiKey: string;
  exchangeApiKey: string;
  exchangeSecretKey: string;
}

export interface DailyStats {
  date: string;
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  maxDrawdown: number;
}
