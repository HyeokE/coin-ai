import { TradingBot } from './core/TradingBot';
import { TradingBotWS } from './core/TradingBotWS';
import { loadConfig, loadRiskPolicy } from './config/config';

class App {
  private bot: TradingBot | TradingBotWS | null = null;

  public async start(): Promise<void> {
    console.log('═══════════════════════════════════════════');
    console.log('       🤖 Auto Coin Trading Bot v1.0       ');
    console.log('═══════════════════════════════════════════');

    const config = loadConfig();
    const riskPolicy = loadRiskPolicy();
    const useWebSocket = process.env.USE_WEBSOCKET === 'true';

    this.validateConfig(config);

    if (useWebSocket) {
      console.log('Mode: WebSocket (Real-time)');
      this.bot = new TradingBotWS(config, riskPolicy);
    } else {
      console.log('Mode: REST API (Polling)');
      this.bot = new TradingBot(config, riskPolicy);
    }

    this.setupGracefulShutdown();
    await this.bot.start();
  }

  private validateConfig(
    config: ReturnType<typeof loadConfig>,
  ): asserts config is ReturnType<typeof loadConfig> {
    const missing: string[] = [];

    if (!config.deepseekApiKey) missing.push('DEEPSEEK_API_KEY');
    if (!config.exchangeApiKey) missing.push('UPBIT_ACCESS_KEY');
    if (!config.exchangeSecretKey) missing.push('UPBIT_SECRET_KEY');

    if (missing.length > 0) {
      console.error('❌ Missing required environment variables:');
      missing.forEach((v) => console.error(`   - ${v}`));
      process.exit(1);
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = (signal: string) => {
      console.log(`\n${signal} received. Shutting down...`);
      this.bot?.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

const app = new App();
app.start().catch(console.error);
