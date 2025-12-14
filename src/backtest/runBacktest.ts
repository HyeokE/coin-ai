import { BacktestSimulator, BacktestConfig, DecisionProvider } from './BacktestSimulator';
import { Candle, TradeSide } from '../types';
import { getSymbolRiskPolicy, getSymbolConfig, GLOBAL_CONFIG } from '../config/config';
import { MarketDataService } from '../market/MarketDataService';
import { VolatilityThresholds } from '../trading/TradingCore';

function simpleStrategy(debug = false): DecisionProvider {
  let signalCount = 0;

  return (candles, signal, position) => {
    if (!signal) {
      return { shouldTrade: false, confidence: 0, reasoning: 'No signal' };
    }

    signalCount++;

    if (position) {
      return { shouldTrade: false, confidence: 0, reasoning: 'Already in position' };
    }

    const rsi = calcRSI(candles, 14);
    const sma20 = calcSMA(candles, 20);
    const currentPrice = candles[candles.length - 1].close;

    let side: TradeSide | undefined;
    let confidence = 0;

    // LONG only (현물 거래 - SHORT 불가)
    if (signal.direction === 'UP' && rsi < 70 && currentPrice > sma20) {
      side = TradeSide.LONG;
      confidence = Math.min(90, 50 + (70 - rsi));
    }

    if (debug && signalCount <= 5) {
      console.log(`   Signal #${signalCount}: ${signal.type} ${signal.direction}`);
      console.log(
        `     RSI: ${rsi.toFixed(1)}, SMA20: ${sma20.toFixed(0)}, Price: ${currentPrice.toFixed(0)}`,
      );
      console.log(`     Decision: ${side || 'SKIP'}, Confidence: ${confidence.toFixed(0)}`);
    }

    if (!side || confidence < 50) {
      return { shouldTrade: false, confidence: 0, reasoning: 'Conditions not met' };
    }

    const stopLoss = currentPrice * 0.98;
    const targetPrice = currentPrice * 1.04;

    return {
      shouldTrade: true,
      side,
      confidence,
      entryPrice: currentPrice,
      stopLoss,
      targetPrice,
      reasoning: `${signal.type} + RSI(${rsi.toFixed(1)}) + Price > SMA20`,
    };
  };
}

function calcRSI(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 50;

  const changes: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    changes.push(candles[i].close - candles[i - 1].close);
  }

  const gains = changes.filter((c) => c > 0);
  const losses = changes.filter((c) => c < 0).map((c) => Math.abs(c));

  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcSMA(candles: Candle[], period: number): number {
  if (candles.length < period) return candles[candles.length - 1].close;
  const slice = candles.slice(-period);
  return slice.reduce((sum, c) => sum + c.close, 0) / period;
}

type CandleType = 'minutes' | 'days';

async function fetchCandles(symbol: string, type: CandleType, count: number): Promise<Candle[]> {
  const marketService = MarketDataService.createSimple(symbol);

  return marketService.fetchCandlesPaginated(
    symbol,
    type,
    count,
    GLOBAL_CONFIG.candleMinutes,
    (loaded, total) => {
      process.stdout.write(`   Fetched ${loaded}/${total}...\r`);
    },
  );
}

function getSymbolThresholds(symbol: string, candleType: CandleType): VolatilityThresholds {
  const config = getSymbolConfig(symbol);

  // 캔들 타입에 따라 priceSurgePct 조정
  // - minutes: 기본값 그대로 (0.015 = 1.5%)
  // - days: 더 큰 움직임 필요 (0.03 = 3%)
  const priceSurgeMultiplier = candleType === 'days' ? 2.0 : 1.0;

  return {
    atrMultiplier: config.atrMultiplier * 0.8, // 백테스트용으로 약간 민감하게
    priceSurgePct: config.priceSurgePct * priceSurgeMultiplier,
    volumeSpikeMultiplier: config.volumeSpikeMultiplier * 0.8,
  };
}

async function runBacktestForSymbol(
  symbol: string,
  candles: Candle[],
  candleType: CandleType,
  debug: boolean,
) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊 ${symbol}`);
  console.log(`${'─'.repeat(50)}`);

  const priceRange = candles.map((c) => c.close);
  const minPrice = Math.min(...priceRange);
  const maxPrice = Math.max(...priceRange);
  const volatility = ((maxPrice - minPrice) / minPrice) * 100;
  console.log(`   Price Range: ${minPrice.toLocaleString()} ~ ${maxPrice.toLocaleString()}`);
  console.log(`   Volatility: ${volatility.toFixed(2)}%`);

  const config: BacktestConfig = {
    symbol,
    initialCapitalKrw: 1_000_000,
    riskPolicy: getSymbolRiskPolicy(symbol),
    volatilityThresholds: getSymbolThresholds(symbol, candleType),
    feeRate: GLOBAL_CONFIG.feeRate,
  };

  const simulator = new BacktestSimulator(config);
  const result = simulator.run(candles, simpleStrategy(debug));

  console.log(`   Signals: ${result.signalsDetected}, Trades: ${result.totalTrades}`);
  console.log(`   Win Rate: ${result.winRate.toFixed(1)}%`);
  console.log(`   PnL: ${result.totalPnl.toFixed(0)} KRW (${result.totalPnlPercent.toFixed(2)}%)`);
  console.log(`   Max DD: ${result.maxDrawdown.toFixed(2)}%`);

  const d = result.debugStats;
  console.log(`   --- Debug (skip reasons) ---`);
  console.log(`   noSignal:      ${d.noSignal}`);
  console.log(`   agentSkip:     ${d.agentSkip}`);
  console.log(`   plannerReject: ${d.plannerReject}`);
  console.log(`   executed:      ${d.executed}`);

  if (result.trades.length > 0) {
    console.log(`   --- Recent Trades ---`);
    result.trades.slice(-3).forEach((t) => {
      const emoji = t.pnl >= 0 ? '💰' : '📉';
      console.log(
        `   ${emoji} ${t.side} @ ${t.entryPrice.toFixed(0)} → ${t.exitPrice.toFixed(0)} | ` +
          `${t.pnlPercent.toFixed(2)}% | ${t.exitReason}`,
      );
    });
  }

  return result;
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('       📊 Multi-Symbol Backtest            ');
  console.log('═══════════════════════════════════════════');

  const symbolsRaw = process.env.SYMBOLS || process.env.SYMBOL || 'KRW-BTC';
  const symbols = symbolsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const candleType: CandleType = (process.env.CANDLE_TYPE as CandleType) || 'days';
  const candleCount = parseInt(process.env.CANDLE_COUNT || '10000', 10);
  const debug = process.env.DEBUG === 'true';

  console.log(`\nSymbols: ${symbols.join(', ')}`);
  console.log(`Candle Type: ${candleType} (${candleCount} candles)`);

  // 심볼별 설정 출력
  console.log('\n--- Symbol Risk Configs ---');
  for (const symbol of symbols) {
    const config = getSymbolConfig(symbol);
    console.log(
      `   ${symbol}: group=${config.group}, riskScale=${config.riskScale}, ` +
        `SL=${(config.stopLossPct * 100).toFixed(1)}%, TP=${(config.takeProfitPct * 100).toFixed(1)}%`,
    );
  }

  const allResults: {
    symbol: string;
    pnl: number;
    pnlPercent: number;
    trades: number;
    winRate: number;
    maxDD: number;
  }[] = [];

  for (const symbol of symbols) {
    try {
      console.log(`\n📥 Fetching ${symbol} ${candleType} candles...`);
      const candles = await fetchCandles(symbol, candleType, candleCount);
      console.log(`   Loaded ${candles.length} candles`);

      const result = await runBacktestForSymbol(symbol, candles, candleType, debug);

      allResults.push({
        symbol,
        pnl: result.totalPnl,
        pnlPercent: result.totalPnlPercent,
        trades: result.totalTrades,
        winRate: result.winRate,
        maxDD: result.maxDrawdown,
      });
    } catch (error) {
      console.error(`   ❌ Failed to backtest ${symbol}:`, error);
    }
  }

  if (allResults.length > 0) {
    console.log('\n═══════════════════════════════════════════');
    console.log('               SUMMARY                     ');
    console.log('═══════════════════════════════════════════\n');

    const totalPnl = allResults.reduce((sum, r) => sum + r.pnl, 0);
    const totalTrades = allResults.reduce((sum, r) => sum + r.trades, 0);
    const avgWinRate =
      allResults.filter((r) => r.trades > 0).reduce((sum, r) => sum + r.winRate, 0) /
      Math.max(1, allResults.filter((r) => r.trades > 0).length);

    console.log('| Symbol     | Trades | Win Rate | Max DD | PnL             |');
    console.log('|------------|--------|----------|--------|-----------------|');
    for (const r of allResults) {
      const pnlStr = `${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(0)} (${r.pnlPercent.toFixed(2)}%)`;
      console.log(
        `| ${r.symbol.padEnd(10)} | ${String(r.trades).padEnd(6)} | ${r.winRate.toFixed(1).padStart(6)}% | ${r.maxDD.toFixed(1).padStart(5)}% | ${pnlStr.padEnd(15)} |`,
      );
    }
    console.log('|------------|--------|----------|--------|-----------------|');
    console.log(
      `| TOTAL      | ${String(totalTrades).padEnd(6)} | ${avgWinRate.toFixed(1).padStart(6)}% |   --   | ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(0)} KRW`.padEnd(
        58,
      ) + '|',
    );
  }
}

main().catch(console.error);
