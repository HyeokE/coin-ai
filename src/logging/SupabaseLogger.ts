import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { DecisionLog, TradeLog } from '../models/log.model';

export class SupabaseLogger {
  private client: SupabaseClient | null = null;
  private enabled = false;

  public constructor() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;

    if (url && key) {
      this.client = createClient(url, key);
      this.enabled = true;
      console.log('📊 Supabase logging enabled');
    } else {
      console.log('📊 Supabase logging disabled (missing credentials)');
    }
  }

  public async logDecision(log: DecisionLog): Promise<void> {
    if (!this.enabled || !this.client) return;

    try {
      const { error } = await this.client.from('decision_logs').insert(log);
      if (error) throw error;
    } catch (err) {
      console.error('Failed to log decision:', err);
    }
  }

  public async logTrade(log: TradeLog): Promise<void> {
    if (!this.enabled || !this.client) return;

    try {
      const { error } = await this.client.from('trade_logs').insert(log);
      if (error) throw error;
    } catch (err) {
      console.error('Failed to log trade:', err);
    }
  }

  public async getRecentDecisions(limit = 10): Promise<DecisionLog[]> {
    if (!this.enabled || !this.client) return [];

    const { data } = await this.client
      .from('decision_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    return data || [];
  }

  public async getRecentTrades(limit = 10): Promise<TradeLog[]> {
    if (!this.enabled || !this.client) return [];

    const { data } = await this.client
      .from('trade_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    return data || [];
  }

  public async getTodayStats(): Promise<{ trades: number; pnl: number }> {
    if (!this.enabled || !this.client) return { trades: 0, pnl: 0 };

    const today = new Date().toISOString().split('T')[0];

    const { data } = await this.client
      .from('trade_logs')
      .select('pnl')
      .eq('action', 'CLOSE')
      .gte('created_at', today);

    const trades = data?.length || 0;
    const pnl = data?.reduce((sum: number, t: { pnl?: number }) => sum + (t.pnl || 0), 0) || 0;

    return { trades, pnl };
  }
}

