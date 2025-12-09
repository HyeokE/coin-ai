import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function generateUpbitJwt(): string {
  const accessKey = process.env.UPBIT_ACCESS_KEY || '';
  const secretKey = process.env.UPBIT_SECRET_KEY || '';

  const payload = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
    timestamp: Date.now(),
  };

  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}

app.get('/api/balance', async (req, res) => {
  try {
    const token = generateUpbitJwt();
    const response = await fetch('https://api.upbit.com/v1/accounts', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch balance' });
    }

    const accounts = (await response.json()) as Array<{
      currency: string;
      balance: string;
      locked: string;
      avg_buy_price: string;
    }>;

    const krw = accounts.find((a) => a.currency === 'KRW');
    const cashKrw = krw ? parseFloat(krw.balance) + parseFloat(krw.locked) : 0;

    const holdings = accounts
      .filter((a) => a.currency !== 'KRW')
      .map((a) => ({
        currency: a.currency,
        balance: parseFloat(a.balance) + parseFloat(a.locked),
        avgBuyPrice: parseFloat(a.avg_buy_price),
        value: (parseFloat(a.balance) + parseFloat(a.locked)) * parseFloat(a.avg_buy_price),
      }))
      .filter((h) => h.balance > 0);

    const holdingsValue = holdings.reduce((sum: number, h: { value: number }) => sum + h.value, 0);
    const totalEquity = cashKrw + holdingsValue;

    res.json({ cashKrw, holdingsValue, totalEquity, holdings });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/prices', async (req, res) => {
  try {
    const symbols = (req.query.symbols as string) || '';
    if (!symbols) return res.json({});

    const symbolList = symbols.split(',').filter(Boolean);
    const response = await fetch(`https://api.upbit.com/v1/ticker?markets=${symbolList.join(',')}`);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch prices' });
    }

    const data = (await response.json()) as Array<{ market: string; trade_price: number }>;
    const prices: Record<string, number> = {};
    data.forEach((item) => {
      prices[item.market] = item.trade_price;
    });

    res.json(prices);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/decisions', async (req, res) => {
  if (!supabase) return res.json([]);

  const limit = parseInt(req.query.limit as string) || 50;
  const symbol = req.query.symbol as string;

  let query = supabase
    .from('decision_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (symbol && symbol !== 'all') {
    query = query.eq('symbol', symbol);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/trades', async (req, res) => {
  if (!supabase) return res.json([]);

  const limit = parseInt(req.query.limit as string) || 50;
  const symbol = req.query.symbol as string;

  let query = supabase
    .from('trade_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (symbol && symbol !== 'all') {
    query = query.eq('symbol', symbol);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/stats', async (req, res) => {
  if (!supabase) {
    return res.json({
      totalTrades: 0,
      winningTrades: 0,
      winRate: 0,
      totalPnl: '0',
      totalDecisions: 0,
      tradeDecisions: 0,
      tradeRate: 0,
      bySymbol: {},
    });
  }

  const days = parseInt(req.query.days as string) || 7;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data: trades } = await supabase
    .from('trade_logs')
    .select('*')
    .eq('action', 'CLOSE')
    .gte('created_at', since.toISOString());

  const { data: decisions } = await supabase
    .from('decision_logs')
    .select('*')
    .gte('created_at', since.toISOString());

  const totalTrades = trades?.length || 0;
  const winningTrades = trades?.filter((t) => (t.pnl || 0) > 0).length || 0;
  const totalPnl = trades?.reduce((sum, t) => sum + (t.pnl || 0), 0) || 0;
  const totalDecisions = decisions?.length || 0;
  const tradeDecisions = decisions?.filter((d) => d.should_trade).length || 0;

  const bySymbol: Record<string, { trades: number; pnl: number; wins: number }> = {};
  trades?.forEach((t) => {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, pnl: 0, wins: 0 };
    bySymbol[t.symbol].trades++;
    bySymbol[t.symbol].pnl += t.pnl || 0;
    if ((t.pnl || 0) > 0) bySymbol[t.symbol].wins++;
  });

  res.json({
    totalTrades,
    winningTrades,
    winRate: totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(1) : 0,
    totalPnl: totalPnl.toFixed(0),
    totalDecisions,
    tradeDecisions,
    tradeRate: totalDecisions > 0 ? ((tradeDecisions / totalDecisions) * 100).toFixed(1) : 0,
    bySymbol,
  });
});

app.get('/api/equity-curve', async (req, res) => {
  if (!supabase) return res.json([]);

  const { data: trades } = await supabase
    .from('trade_logs')
    .select('created_at, pnl, symbol')
    .eq('action', 'CLOSE')
    .order('created_at', { ascending: true });

  let cumulative = 0;
  const curve = trades?.map((t) => {
    cumulative += t.pnl || 0;
    return {
      date: t.created_at,
      pnl: cumulative,
      symbol: t.symbol,
    };
  });

  res.json(curve || []);
});

app.get('/api/daily-pnl', async (req, res) => {
  if (!supabase) return res.json([]);

  const days = parseInt(req.query.days as string) || 30;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const { data: trades } = await supabase
    .from('trade_logs')
    .select('created_at, pnl')
    .eq('action', 'CLOSE')
    .gte('created_at', since.toISOString());

  const dailyPnl: Record<string, number> = {};
  trades?.forEach((t) => {
    const date = t.created_at.split('T')[0];
    dailyPnl[date] = (dailyPnl[date] || 0) + (t.pnl || 0);
  });

  const result = Object.entries(dailyPnl)
    .map(([date, pnl]) => ({ date, pnl }))
    .sort((a, b) => a.date.localeCompare(b.date));

  res.json(result);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`📊 Dashboard running at http://localhost:${PORT}`);
});
