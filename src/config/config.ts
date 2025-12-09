import { BotConfig } from '../types';
import { RiskPolicy } from '../planner/OrderPlanner';

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
}

/**
 * 전역 설정
 * - 계좌 전체에 적용되는 리스크/거래 제한
 */
export const GLOBAL_CONFIG: GlobalConfig = {
  maxTotalExposurePct: 0.55, // 전체 포지션 합산 최대 55% (코인간 상관관계 고려)
  maxDailyLossPct: 0.05, // 일일 최대 손실 20% 도달 시 시스템 자동 정지
  maxDailyTrades: 30, // 하루 최대 30회 거래 (과매매 방지)
  minNotionalKrw: 1_000, // 최소 주문 금액 1,000원
  maxNotionalKrw: 1_500_000, // 단일 주문 최대 150만원
  intervalMs: 30_000, // 분석 주기 30초 (5분봉 기준 적정)
  cooldownMs: 180_000, // 거래 후 휴식 3분 (리벤지 매매 방지)
};

/**
 * 심볼별 기본 설정 (B그룹 중간 리스크 기준)
 * - A그룹(메이저): 더 민감하게 오버라이드
 * - C그룹(알트): 더 보수적으로 오버라이드
 */
const BASE_SYMBOL_CONFIG: SymbolConfig = {
  group: 'B', // 리스크 그룹: A(메이저), B(중간), C(고위험 알트)

  // ─── 포지션 사이징 ───
  riskScale: 0.4, // 리스크 배율 (baseRiskPerTradePct × riskScale = 실제 리스크)
  maxPositionPct: 0.15, // 단일 코인 최대 포지션 15%

  // ─── 손절/익절 ───
  stopLossPct: 0.018, // 손절 1.8%
  takeProfitPct: 0.036, // 익절 3.6% (리스크:리워드 = 1:2)
  maxDrawdownPct: 0.04, // 심볼 단위 최대 손실 4% 도달 시 청산

  // ─── 변동성 트리거 임계값 ───
  atrMultiplier: 1.3, // ATR이 평균의 1.3배 이상이면 신호
  priceSurgePct: 0.012, // 가격이 1.2% 이상 급등/급락하면 신호
  volumeSpikeMultiplier: 2.0, // 거래량이 평균의 2배 이상이면 신호

  // ─── 리스크 계산 ───
  baseRiskPerTradePct: 0.005, // 트레이드당 기본 리스크 0.5%
  fallbackStopLossPct: 0.007, // AI가 SL 안 줬을 때 기본 손절 0.7%
};
/**
 * 심볼별 개별 설정 오버라이드
 * - BASE_SYMBOL_CONFIG를 기본으로, 심볼별 특성에 맞게 덮어씀
 */
export const SYMBOL_CONFIGS: Record<string, Partial<SymbolConfig>> = {
  // ═══════════════════════════════════════════════════════════════════
  // A 그룹: 메이저 코인 (유동성↑, 변동성↓, 신뢰도↑)
  // ═══════════════════════════════════════════════════════════════════
  'KRW-BTC': {
    group: 'A',
    riskScale: 0.6, // ≈ 0.3% risk/trade
    maxPositionPct: 0.4, // 계좌의 18%까지

    stopLossPct: 0.018, // 1.8%
    takeProfitPct: 0.036, // 3.6%

    // 변동성 조건: 메이저 + 상대적 저변동이라 조금 민감하게
    atrMultiplier: 1.1, // BASE 1.3 → 1.1
    priceSurgePct: 0.008, // 0.8% 이상 움직임
    // volumeSpikeMultiplier: BASE(2.0) 사용
  },

  // ════════════════════════════════════════
  // 서브 티어: ETH (변동성↑, 리스크↓)
  // ════════════════════════════════════════
  'KRW-ETH': {
    group: 'A',

    // BTC보다 한 단계 낮은 티어
    riskScale: 0.3, // 0.5% × 0.3 = 0.15%/trade
    maxPositionPct: 0.3, // 계좌 12%까지

    stopLossPct: 0.022, // SL 2.2%
    takeProfitPct: 0.044, // TP 4.4% (RR ~1:2 유지)

    // 변동성 기준: 100k 분봉 기준 시그널이 수백~천 단위 정도 나오게
    atrMultiplier: 1.4, // 예전 1.0 / 1.6 사이 타협
    priceSurgePct: 0.0125, // ~1.25% 이상
    volumeSpikeMultiplier: 2.3,
  },

  // ════════════════════════════════════════
  // 서브 티어: XRP (BTC보단 변동성↑, ETH보단 약간↓ 느낌)
  // ════════════════════════════════════════
  'KRW-XRP': {
    group: 'A',

    // ETH보다 아주 약간만 공격적
    riskScale: 0.35, // ≈ 0.175%/trade
    maxPositionPct: 0.3,

    stopLossPct: 0.022,
    takeProfitPct: 0.044,

    // 시그널: ETH와 비슷한 수준의 필터, 약간 더 자주 반응
    atrMultiplier: 1.35,
    priceSurgePct: 0.013, // ~1.3% 이상
    volumeSpikeMultiplier: 2.3,
  },

  // ═══════════════════════════════════════════════════════════════════
  // B 그룹: 중간~고 변동성 (알트 중 상위권)
  // ═══════════════════════════════════════════════════════════════════

  'KRW-SOL': {
    group: 'B',
    riskScale: 0.4, // 실제 리스크 = 0.5% × 0.4 = 0.2%/트레이드
    maxPositionPct: 0.12, // 메이저보다 포지션 제한↓
    stopLossPct: 0.028, // 손절 2.8% (변동성 큼)
    takeProfitPct: 0.06, // 익절 6%
    atrMultiplier: 1.35,
    priceSurgePct: 0.013,
  },

  'KRW-ADA': {
    group: 'B',
    riskScale: 0.4,
    maxPositionPct: 0.12,
    stopLossPct: 0.022, // 손절 2.2%
    takeProfitPct: 0.045, // 익절 4.5%
    atrMultiplier: 1.35,
    priceSurgePct: 0.013,
  },

  'KRW-DOGE': {
    group: 'B',
    riskScale: 0.3, // 밈코인 특성상 보수적으로
    maxPositionPct: 0.1, // 포지션 10%로 제한
    stopLossPct: 0.03, // 손절 3%
    takeProfitPct: 0.06, // 익절 6%
    atrMultiplier: 1.4, // 둔감하게 (노이즈 필터링)
    priceSurgePct: 0.015,
  },

  // ═══════════════════════════════════════════════════════════════════
  // C 그룹: 고위험 알트 (급등락 심함, 유동성↓)
  // ═══════════════════════════════════════════════════════════════════

  'KRW-SXP': {
    group: 'C',
    riskScale: 0.25, // 실제 리스크 = 0.5% × 0.25 = 0.125%/트레이드
    maxPositionPct: 0.08, // 포지션 8% 제한 (큰 돈 안 맡김)
    stopLossPct: 0.035, // 손절 3.5%
    takeProfitPct: 0.08, // 익절 8%
    atrMultiplier: 1.8, // 매우 둔감하게 (진짜 스파이크만)
    priceSurgePct: 0.02, // 2% 이상 급등/급락만 신호
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
      //   주석에 “0~100, 예: 1.5 = 1.5%”라고 박아두면 더 안전할 듯.
      priceSurgePercentValue: BASE_SYMBOL_CONFIG.priceSurgePct * 100,
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

export function getVolatilityThresholds(symbol: string) {
  const config = getSymbolConfig(symbol);
  return {
    atrMultiplier: config.atrMultiplier,
    priceSurgePercent: config.priceSurgePct * 100,
    volumeSpikeMultiplier: config.volumeSpikeMultiplier,
  };
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

  // 1) 저변동 – 조금 더 타이트하게
  if (volPercent < 2) {
    return {
      sl: Math.max(config.stopLossPct * 0.7, 0.01), // 최소 1%
      tp: Math.max(config.takeProfitPct * 0.7, 0.02), // 최소 2%
    };
  }

  // 2) 중간 변동 – 기본값
  if (volPercent < 6) {
    return {
      sl: config.stopLossPct,
      tp: config.takeProfitPct,
    };
  }

  // 3) 고변동 – SL/TP 둘 다 넓게
  return {
    sl: Math.max(config.stopLossPct * 1.3, 0.03), // 최소 3%
    tp: Math.max(config.takeProfitPct * 1.3, 0.06), // 최소 6%
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
