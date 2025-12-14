export interface DecisionRecord {
  timestamp: number;
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD' | 'SKIP';
  confidence: number;
  reasoning: string;
  price: number;
  result?: 'WIN' | 'LOSS' | 'PENDING';
}

export class DecisionHistory {
  private readonly history: DecisionRecord[] = [];
  private readonly maxSize: number;

  public constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  public add(record: DecisionRecord): void {
    this.history.unshift(record);
    while (this.history.length > this.maxSize) {
      this.history.pop();
    }
  }

  public getRecent(count = 20): DecisionRecord[] {
    return this.history.slice(0, count);
  }

  public getBySymbol(symbol: string, count = 20): DecisionRecord[] {
    return this.history.filter((r) => r.symbol === symbol).slice(0, count);
  }

  public updateResult(timestamp: number, result: 'WIN' | 'LOSS'): void {
    const record = this.history.find((r) => r.timestamp === timestamp);
    if (record) record.result = result;
  }

  public toSummary(records: DecisionRecord[]): string {
    if (records.length === 0) return 'No previous decisions';

    return records
      .map((r, i) => {
        const time = new Date(r.timestamp).toISOString().slice(11, 19);
        const resultEmoji = r.result === 'WIN' ? '✅' : r.result === 'LOSS' ? '❌' : '⏳';
        return `${i + 1}. [${time}] ${r.action} ${r.symbol} @${r.price.toLocaleString()} (${r.confidence}%) ${resultEmoji}`;
      })
      .join('\n');
  }
}

