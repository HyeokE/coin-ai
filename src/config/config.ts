import { BotConfig } from '../types';
import { RiskPolicy } from '../planner/OrderPlanner';
import { CandleUnit } from '../models/upbit';

const ALLOWED_CANDLE_UNITS: CandleUnit[] = [1, 3, 5, 15, 30, 60, 240];

function resolveCandleMinutesFromEnv(defaultUnit: CandleUnit = 60): CandleUnit {
  const raw = process.env.TF ?? process.env.CANDLE_MINUTES;
  if (!raw) return defaultUnit;

  const n = Number(raw);
  if (Number.isFinite(n) && ALLOWED_CANDLE_UNITS.includes(n as CandleUnit)) {
    return n as CandleUnit;
  }

  console.warn(
    `⚠️ Invalid TF/CANDLE_MINUTES="${raw}". Allowed: ${ALLOWED_CANDLE_UNITS.join(', ')}. Using ${defaultUnit}.`,
  );
  return defaultUnit;
}

// ═══════════════════════════════════════════════════════════════════
// Optimization Config (최적화 설정)
// ═══════════════════════════════════════════════════════════════════
export type OptMode = 'FULL' | 'VOL_ONLY';

export interface OptimizationConfig {
  mode: OptMode;
  gateOnSignal: boolean;
  signalTypes?: string[];
  useSignalExit: boolean;

  atrMults: number[];
  surgePcts: number[];
  volSpikes: number[];

  strategyGrid: {
    rsiLowers: number[];
    swingLookbacks: number[];
    rrs: number[];
    stopBuffers: number[];
    beTriggers: number[];
    dipLookbacks: number[];
    comboCap: number;
  };

  fixedStrategy: {
    rsiLower: number;
    swingLookback: number;
    rr: number;
    stopBufferPct: number;
    beTriggerR: number;
    useEma200Filter: boolean;
    useRibbonEma200Filter: boolean;
    dipLookback: number;
    useDipReclaim: boolean;
    useKnn: boolean;
  };
}

export const OPTIMIZATION_CONFIG: OptimizationConfig = {
  mode: 'VOL_ONLY',
  gateOnSignal: false,
  signalTypes: undefined,
  useSignalExit: true,

  atrMults: [0.6, 0.8, 1.0, 1.2],
  surgePcts: [0.003, 0.006, 0.009],
  volSpikes: [1.2, 1.5, 1.8, 2.0],

  strategyGrid: {
    rsiLowers: [40],
    swingLookbacks: [8, 12, 16],
    rrs: [1.5, 2.0],
    stopBuffers: [0.0007, 0.001, 0.0015],
    beTriggers: [0.15, 0.25],
    dipLookbacks: [3, 5],
    comboCap: 200,
  },

  fixedStrategy: {
    rsiLower: 40,
    swingLookback: 12,
    rr: 2.0,
    stopBufferPct: 0.001,
    beTriggerR: 0.25,
    useEma200Filter: false,
    useRibbonEma200Filter: false,
    dipLookback: 5,
    useDipReclaim: true,
    useKnn: true,
  },
};

// ═══════════════════════════════════════════════════════════════════
// Breakout Strategy Config (Breakout 전략 설정)
// ═══════════════════════════════════════════════════════════════════
export type BreakoutMode = 'immediate' | 'confirmed' | 'retest';

export interface BreakoutStrategyConfig {
  mode: BreakoutMode;
  rsiMin: number;
  atrMultiplier: number;
  rr: number;
  beTriggerR: number;
  retestLookback: number;
}

export const BREAKOUT_STRATEGY_CONFIG: BreakoutStrategyConfig = {
  mode: 'retest',
  rsiMin: 55,
  atrMultiplier: 1.5,
  rr: 3.0,
  beTriggerR: 0.25,
  retestLookback: 10,
};

// ═══════════════════════════════════════════════════════════════════
// Symbol Config
// ═══════════════════════════════════════════════════════════════════

/**
 * 심볼별 설정
 * - 모든 ratio/pct는 0~1 범위 (0.01 = 1%, 0.1 = 10%)
 * - priceSurgePct: 가격 급등/급락 감지 임계값 (0.015 = 1.5%)
 */
export interface SymbolConfig {
  group: 'A' | 'B' | 'C';
  riskScale: number;
  maxPositionPct: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxDrawdownPct: number;
  atrMultiplier: number;
  priceSurgePct: number;
  volumeSpikeMultiplier: number;
  baseRiskPerTradePct: number;
  fallbackStopLossPct: number;
}

/**
 * 글로벌 설정 (계좌 전체 기준)
 */
export interface GlobalConfig {
  maxTotalExposurePct: number;
  maxDailyLossPct: number;
  maxDailyTrades: number;
  minNotionalKrw: number;
  maxNotionalKrw: number;
  intervalMs: number;
  cooldownMs: number;
  candleMinutes: CandleUnit;
  feeRate: number;
}
/**
 * 전역 설정
 * - 계좌 전체에 적용되는 리스크/거래 제한
 */
export const GLOBAL_CONFIG: GlobalConfig = {
  maxTotalExposurePct: 0.8,
  maxDailyLossPct: 0.05,
  maxDailyTrades: 10,
  minNotionalKrw: 5_000,
  maxNotionalKrw: 2_000_000,
  intervalMs: 20_000,
  cooldownMs: 45_000,
  candleMinutes: resolveCandleMinutesFromEnv(60),
  feeRate: 0.0005,
};

/**
 * 심볼별 기본 설정
 */
const BASE_SYMBOL_CONFIG: SymbolConfig = {
  group: 'B',

  // ─── 포지션 사이징 ───
  riskScale: 1.0,
  maxPositionPct: 0.2,

  // ─── 손절/익절 ───
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
  maxDrawdownPct: 0.05,

  // ─── 신호 민감도 ───
  atrMultiplier: 1.5,
  priceSurgePct: 0.015,
  volumeSpikeMultiplier: 2.0,

  // ─── 리스크 ───
  baseRiskPerTradePct: 0.01,
  fallbackStopLossPct: 0.005,
};

/**
 * 심볼별 오버라이드
 */
export const SYMBOL_CONFIGS: Record<string, Partial<SymbolConfig>> = {
  'KRW-BTC': {
    group: 'A',
    riskScale: 0.7,
    maxPositionPct: 0.35,
    stopLossPct: 0.018,
    takeProfitPct: 0.038,
    atrMultiplier: 0.7,
    priceSurgePct: 0.005,
    volumeSpikeMultiplier: 1.8,
  },

  'KRW-ETH': {
    group: 'A',
    riskScale: 0.6,
    maxPositionPct: 0.28,
    stopLossPct: 0.022,
    takeProfitPct: 0.048,
    atrMultiplier: 0.7,
    priceSurgePct: 0.006,
    volumeSpikeMultiplier: 2.0,
  },

  'KRW-SOL': {
    group: 'B',
    riskScale: 0.45,
    maxPositionPct: 0.15,
    stopLossPct: 0.03,
    takeProfitPct: 0.06,
    atrMultiplier: 1.2,
    priceSurgePct: 0.012,
  },
};

export function getSymbolConfig(symbol: string): SymbolConfig {
  const override = SYMBOL_CONFIGS[symbol] || {};
  return { ...BASE_SYMBOL_CONFIG, ...override };
}

export function loadConfig(): BotConfig {
  const symbolsRaw = process.env.SYMBOLS || process.env.SYMBOL || 'KRW-BTC';
  const symbols = symbolsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    symbols,
    intervalMs: GLOBAL_CONFIG.intervalMs,
    cooldownMs: GLOBAL_CONFIG.cooldownMs,

    riskLimits: {
      maxPositionSizeRatio: BASE_SYMBOL_CONFIG.maxPositionPct,
      maxDailyLossRatio: GLOBAL_CONFIG.maxDailyLossPct,
      maxDailyTrades: GLOBAL_CONFIG.maxDailyTrades,
      stopLossRatio: BASE_SYMBOL_CONFIG.stopLossPct,
      takeProfitRatio: BASE_SYMBOL_CONFIG.takeProfitPct,
      maxDrawdownRatio: BASE_SYMBOL_CONFIG.maxDrawdownPct,
    },

    volatilityThresholds: {
      atrMultiplier: BASE_SYMBOL_CONFIG.atrMultiplier,
      priceSurgePct: BASE_SYMBOL_CONFIG.priceSurgePct,
      volumeSpikeMultiplier: BASE_SYMBOL_CONFIG.volumeSpikeMultiplier,
    },

    deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
    exchangeApiKey: process.env.UPBIT_ACCESS_KEY || '',
    exchangeSecretKey: process.env.UPBIT_SECRET_KEY || '',
  };
}

export function getRiskScaleForSymbol(symbol: string): number {
  return getSymbolConfig(symbol).riskScale;
}

/**
 * 변동성 기반 SL/TP 계산
 * - volatilityPct: ATR / currentPrice (0~1 범위)
 * - 변동성 높을수록 SL/TP 넓게
 */
export function getVolatilityBasedSlTp(
  symbol: string,
  volatilityPct?: number,
): { sl: number; tp: number } {
  const config = getSymbolConfig(symbol);

  if (volatilityPct === undefined) {
    return { sl: config.stopLossPct, tp: config.takeProfitPct };
  }

  const volPercent = volatilityPct * 100;

  // 1) 저변동
  if (volPercent < 2) {
    return {
      sl: Math.max(config.stopLossPct * 0.8, 0.012),
      tp: Math.max(config.takeProfitPct * 0.8, 0.024),
    };
  }

  // 2) 중간 변동
  if (volPercent < 6) {
    return {
      sl: config.stopLossPct,
      tp: config.takeProfitPct,
    };
  }

  // 3) 고변동
  return {
    sl: Math.max(config.stopLossPct * 1.3, 0.035),
    tp: Math.max(config.takeProfitPct * 1.3, 0.07),
  };
}
/**
 * 심볼별 RiskPolicy 반환
 * - riskScale이 baseRiskPerTradePct에 적용됨
 * - BTC/XRP(1.0) → 1%, SOL(0.5) → 0.5%, DOGE/SXP(0.3) → 0.3%
 */
export function getSymbolRiskPolicy(symbol: string): RiskPolicy {
  const config = getSymbolConfig(symbol);
  return {
    riskPerTradePct: config.baseRiskPerTradePct * config.riskScale,
    maxPositionPctPerSymbol: config.maxPositionPct,
    maxTotalExposurePct: GLOBAL_CONFIG.maxTotalExposurePct,
    maxDailyLossPct: GLOBAL_CONFIG.maxDailyLossPct,
    minNotionalKrw: GLOBAL_CONFIG.minNotionalKrw,
    maxNotionalKrw: GLOBAL_CONFIG.maxNotionalKrw,
    fallbackStopLossPct: config.fallbackStopLossPct,
  };
}

/**
 * @deprecated 심볼별 정책 사용 권장 → getSymbolRiskPolicy(symbol)
 * 백테스트 등 심볼 개념 없이 기본값만 필요할 때 사용
 */
export function loadRiskPolicy(): RiskPolicy {
  return {
    riskPerTradePct: BASE_SYMBOL_CONFIG.baseRiskPerTradePct,
    maxPositionPctPerSymbol: BASE_SYMBOL_CONFIG.maxPositionPct,
    maxTotalExposurePct: GLOBAL_CONFIG.maxTotalExposurePct,
    maxDailyLossPct: GLOBAL_CONFIG.maxDailyLossPct,
    minNotionalKrw: GLOBAL_CONFIG.minNotionalKrw,
    maxNotionalKrw: GLOBAL_CONFIG.maxNotionalKrw,
    fallbackStopLossPct: BASE_SYMBOL_CONFIG.fallbackStopLossPct,
  };
}
