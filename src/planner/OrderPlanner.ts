import { AgentDecision, MarketData, VolatilitySignal, Position, TradeSide } from '../types';
import { GLOBAL_CONFIG } from '../config/config';

export enum PlanOrderType {
  MARKET = 'MARKET',
  LIMIT = 'LIMIT',
}

export interface PortfolioState {
  totalEquityKrw: number;
  cashKrw: number;
  positions: Position[];
  realizedPnlTodayPct: number;
}

export interface RiskPolicy {
  riskPerTradePct: number;
  maxPositionPctPerSymbol: number;
  maxTotalExposurePct: number;
  maxDailyLossPct: number;
  minNotionalKrw: number;
  maxNotionalKrw: number;
  fallbackStopLossPct: number;
}

export interface OrderPlan {
  shouldExecute: boolean;
  symbol: string;
  side?: TradeSide;
  orderType: PlanOrderType;
  quantity?: number;
  entryPrice?: number;
  stopLoss?: number;
  targetPrice?: number;
  notionalKrw?: number;
  reason: string;
  riskSummary?: {
    appliedRiskPct: number;
    riskAmountKrw: number;
    symbolExposureBefore: number;
    symbolExposureAfter?: number;
    totalExposureBefore: number;
    totalExposureAfter?: number;
    riskScale?: number;
  };
}

export class OrderPlanner {
  public constructor(private readonly risk: RiskPolicy) {}

  public planOrder(params: {
    decision: AgentDecision;
    marketData: MarketData;
    portfolio: PortfolioState;
    volatility: VolatilitySignal | undefined;
    riskScale?: number;
    customSlTp?: { sl: number; tp: number };
  }): OrderPlan {
    const { decision, marketData, portfolio, riskScale = 1.0, customSlTp } = params;
    const symbol = marketData.symbol;

    if (!decision.shouldTrade || !decision.side) {
      return this.reject(symbol, 'Agent decided not to trade');
    }

    // if (portfolio.realizedPnlTodayPct <= -this.risk.maxDailyLossPct) {
    //   return this.reject(symbol, 'Daily loss limit exceeded');
    // }

    const currentPosition = this.findPosition(portfolio.positions, symbol);
    const symbolExposureBefore = this.calcSymbolExposure(currentPosition, marketData.price);
    const totalExposureBefore = this.calcTotalExposure(portfolio);

    const confidenceFactor = this.clamp((decision.confidence ?? 0) / 100, 0, 1);
    if (confidenceFactor <= 0) {
      return this.reject(symbol, 'Confidence too low');
    }

    const appliedRiskPct = this.risk.riskPerTradePct * confidenceFactor * riskScale;

    // 🔴 기존: 작은 계좌면 그냥 리젝
    // const riskAmountKrw = portfolio.totalEquityKrw * appliedRiskPct;
    // if (riskAmountKrw < this.risk.minNotionalKrw) {
    //   return this.reject(symbol, 'Risk amount below minimum notional');
    // }

    // ✅ 수정: 최소 주문 금액 이상으로 강제 상향
    const rawRiskAmountKrw = portfolio.totalEquityKrw * appliedRiskPct;
    const riskAmountKrw = Math.max(rawRiskAmountKrw, this.risk.minNotionalKrw);

    const entryPrice = this.positiveNum(decision.entryPrice ?? marketData.price);
    if (!entryPrice) {
      return this.reject(symbol, 'Invalid entry price');
    }

    const slRatio = customSlTp?.sl ?? this.risk.fallbackStopLossPct;
    const stopLoss = this.calcStopLoss(decision, entryPrice, slRatio);

    const feeRate = GLOBAL_CONFIG.feeRate;
    let perUnitRisk: number;
    if (decision.side === TradeSide.LONG) {
      const entryCost = entryPrice * (1 + feeRate);
      const slProceeds = stopLoss * (1 - feeRate);
      perUnitRisk = entryCost - slProceeds;
    } else {
      const entryProceeds = entryPrice * (1 - feeRate);
      const slCost = stopLoss * (1 + feeRate);
      perUnitRisk = slCost - entryProceeds;
    }

    if (perUnitRisk <= 0) {
      return this.reject(symbol, 'Invalid stopLoss/entryPrice combination (after fees)');
    }

    const quantityByRisk = riskAmountKrw / perUnitRisk;
    if (!Number.isFinite(quantityByRisk) || quantityByRisk <= 0) {
      return this.reject(symbol, 'Computed quantity is invalid');
    }

    const desiredNotionalKrw = quantityByRisk * entryPrice;

    const maxSymbolExposure = portfolio.totalEquityKrw * this.risk.maxPositionPctPerSymbol;
    const maxTotalExposure = portfolio.totalEquityKrw * this.risk.maxTotalExposurePct;

    const remainingSymbol = Math.max(0, maxSymbolExposure - symbolExposureBefore);
    const remainingTotal = Math.max(0, maxTotalExposure - totalExposureBefore);

    let maxAllowed = Math.min(remainingSymbol, remainingTotal, this.risk.maxNotionalKrw);
    maxAllowed = Math.min(maxAllowed, portfolio.cashKrw);

    if (maxAllowed <= 0) {
      return this.reject(symbol, 'No capacity for additional exposure');
    }

    const finalNotionalKrw = Math.min(desiredNotionalKrw, maxAllowed);

    // 🔐 이건 그대로 두자: 실제 주문이 거래소 최소 단위보다 작으면 의미가 없으니까
    if (finalNotionalKrw < this.risk.minNotionalKrw) {
      return this.reject(symbol, 'Final notional below minimum');
    }

    const quantity = this.roundQty(finalNotionalKrw / entryPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return this.reject(symbol, 'Final quantity invalid after rounding');
    }

    const tpRatio = customSlTp?.tp ?? this.risk.fallbackStopLossPct * 2;
    const targetPrice =
      decision.targetPrice ??
      (decision.side === TradeSide.LONG ? entryPrice * (1 + tpRatio) : entryPrice * (1 - tpRatio));

    const rewardCheckResult = this.checkRewardAfterFees(
      decision.side!,
      entryPrice,
      targetPrice,
      perUnitRisk,
      feeRate,
    );
    if (rewardCheckResult) {
      return this.reject(symbol, rewardCheckResult);
    }

    return {
      shouldExecute: true,
      symbol,
      side: decision.side,
      orderType: PlanOrderType.MARKET,
      quantity,
      entryPrice,
      stopLoss,
      targetPrice,
      notionalKrw: finalNotionalKrw,
      reason: decision.reasoning ?? 'Planned by OrderPlanner',
      riskSummary: {
        appliedRiskPct,
        riskAmountKrw,
        symbolExposureBefore,
        symbolExposureAfter: symbolExposureBefore + finalNotionalKrw,
        totalExposureBefore,
        totalExposureAfter: totalExposureBefore + finalNotionalKrw,
        riskScale,
      },
    };
  }

  private reject(symbol: string, reason: string): OrderPlan {
    return { shouldExecute: false, symbol, orderType: PlanOrderType.MARKET, reason };
  }

  private findPosition(positions: Position[], symbol: string): Position | undefined {
    return positions.find((p) => p.symbol === symbol);
  }

  private calcSymbolExposure(pos: Position | undefined, price: number): number {
    if (!pos) return 0;
    return (pos.quantity ?? 0) * price;
  }

  private calcTotalExposure(portfolio: PortfolioState): number {
    return Math.max(0, portfolio.totalEquityKrw - portfolio.cashKrw);
  }

  private calcStopLoss(decision: AgentDecision, entryPrice: number, slRatio: number): number {
    const side = decision.side;
    const raw = this.positiveNum(decision.stopLoss);

    if (raw) {
      if (side === TradeSide.LONG && raw < entryPrice) return raw;
      if (side === TradeSide.SHORT && raw > entryPrice) return raw;
    }

    const fallback = entryPrice * slRatio;
    return side === TradeSide.LONG ? entryPrice - fallback : entryPrice + fallback;
  }

  private clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
  }

  private positiveNum(v: unknown): number | undefined {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  private roundQty(q: number): number {
    return Number(q.toFixed(8));
  }

  private checkRewardAfterFees(
    side: TradeSide,
    entryPrice: number,
    targetPrice: number,
    perUnitRisk: number,
    feeRate: number,
  ): string | null {
    if (side === TradeSide.LONG) {
      const entryCost = entryPrice * (1 + feeRate);
      const tpProceeds = targetPrice * (1 - feeRate);
      const perUnitReward = tpProceeds - entryCost;
      if (perUnitReward <= 0) {
        return 'Reward after fees is non-positive';
      }
    } else {
      const entryProceeds = entryPrice * (1 - feeRate);
      const tpCost = targetPrice * (1 + feeRate);
      const perUnitReward = entryProceeds - tpCost;
      if (perUnitReward <= 0) {
        return 'Reward after fees is non-positive';
      }
    }
    return null;
  }
}
