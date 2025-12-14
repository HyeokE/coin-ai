import { GuardrailEngine, PreTradeContext, ClosedTrade } from '../trading/GuardrailEngine';
import { MarketDataService } from '../market/MarketDataService';
import { GLOBAL_CONFIG } from '../config/config';

async function testMicrostructure() {
  console.log('═══════════════════════════════════════════');
  console.log('   📊 Microstructure Test');
  console.log('═══════════════════════════════════════════');

  const symbols = ['KRW-BTC', 'KRW-ETH', 'KRW-SOL'];
  const market = MarketDataService.createSimple('KRW-BTC');

  for (const symbol of symbols) {
    const ms = await market.getMicrostructure(symbol);
    console.log(`\n${symbol}:`);
    console.log(`   Price: ${ms.price.toLocaleString()} KRW`);
    console.log(`   Spread: ${ms.spreadPct.toFixed(4)}%`);
    console.log(`   TopBook: ${(ms.topBookKrw / 1_000_000).toFixed(1)}M KRW`);
    console.log(`   24h Volume: ${(ms.volume24hKrw / 1_000_000_000).toFixed(1)}B KRW`);
  }
}

function testGuardrailEngine() {
  console.log('\n═══════════════════════════════════════════');
  console.log('   🛡️ GuardrailEngine Test');
  console.log('═══════════════════════════════════════════');

  const engine = new GuardrailEngine();

  const baseCtx: PreTradeContext = {
    nowMs: Date.now(),
    symbol: 'KRW-BTC',
    stopPct: 1.0,
    feeInR: 0.09,
    spreadPct: 0.02,
    topBookKrw: 50_000_000,
    volume24hKrw: 100_000_000_000,
    lastCandleTs: Date.now() - 30_000,
    tfMinutes: 60,
  };

  console.log('\n1) Normal trade (should ALLOW):');
  let decision = engine.check(baseCtx);
  console.log(`   ${decision.allow ? '✅ ALLOWED' : '❌ BLOCKED: ' + decision.reason}`);

  console.log('\n2) Too tight stop (should BLOCK):');
  decision = engine.check({ ...baseCtx, stopPct: 0.3 });
  console.log(`   ${decision.allow ? '✅ ALLOWED' : '❌ BLOCKED: ' + decision.reason}`);

  console.log('\n3) High feeInR (should BLOCK):');
  decision = engine.check({ ...baseCtx, feeInR: 0.25 });
  console.log(`   ${decision.allow ? '✅ ALLOWED' : '❌ BLOCKED: ' + decision.reason}`);

  console.log('\n4) Wide spread (should BLOCK):');
  decision = engine.check({ ...baseCtx, spreadPct: 0.15 });
  console.log(`   ${decision.allow ? '✅ ALLOWED' : '❌ BLOCKED: ' + decision.reason}`);

  console.log('\n5) Shallow orderbook (should BLOCK):');
  decision = engine.check({ ...baseCtx, topBookKrw: 5_000_000 });
  console.log(`   ${decision.allow ? '✅ ALLOWED' : '❌ BLOCKED: ' + decision.reason}`);

  console.log('\n6) Stale candles (should BLOCK):');
  decision = engine.check({ ...baseCtx, lastCandleTs: Date.now() - 3 * 60 * 60_000 });
  console.log(`   ${decision.allow ? '✅ ALLOWED' : '❌ BLOCKED: ' + decision.reason}`);

  console.log('\n7) Simulate 4 consecutive SL:');
  for (let i = 0; i < 4; i++) {
    engine.onTradeClosed({ r: -1, pnlPct: -0.5, exitReason: 'STOP_LOSS' });
  }
  console.log(`   State: ${engine.getStats()}`);
  decision = engine.check(baseCtx);
  console.log(`   ${decision.allow ? '✅ ALLOWED' : '❌ BLOCKED: ' + decision.reason}`);

  console.log('\n8) Reset with TP:');
  const engine2 = new GuardrailEngine();
  engine2.onTradeClosed({ r: 3, pnlPct: 1.5, exitReason: 'TAKE_PROFIT' });
  console.log(`   State: ${engine2.getStats()}`);
  decision = engine2.check(baseCtx);
  console.log(`   ${decision.allow ? '✅ ALLOWED' : '❌ BLOCKED: ' + decision.reason}`);

  console.log('\n9) Daily loss limit (-3R):');
  const engine3 = new GuardrailEngine();
  for (let i = 0; i < 3; i++) {
    engine3.onTradeClosed({ r: -1.1, pnlPct: -0.5, exitReason: 'STOP_LOSS' });
  }
  console.log(`   State: ${engine3.getStats()}`);
  decision = engine3.check(baseCtx);
  console.log(`   ${decision.allow ? '✅ ALLOWED' : '❌ BLOCKED: ' + decision.reason}`);
}

async function main() {
  await testMicrostructure();
  testGuardrailEngine();
  console.log('\n✅ All Tests Complete');
}

main().catch(console.error);

