interface FearGreedData {
  value: number;
  classification: string;
  timestamp: number;
}

interface FearGreedApiResponse {
  data: Array<{
    value: string;
    value_classification: string;
    timestamp: string;
  }>;
}

export class FearGreedService {
  private static readonly API_URL = 'https://api.alternative.me/fng/';
  private static readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1시간

  private cache: FearGreedData | null = null;
  private lastFetch = 0;

  public async getFearGreedIndex(): Promise<FearGreedData | null> {
    const now = Date.now();

    if (this.cache && now - this.lastFetch < FearGreedService.CACHE_TTL_MS) {
      return this.cache;
    }

    try {
      const response = await fetch(FearGreedService.API_URL);
      if (!response.ok) return this.cache;

      const data = (await response.json()) as FearGreedApiResponse;
      const latest = data.data?.[0];

      if (!latest) return this.cache;

      this.cache = {
        value: parseInt(latest.value, 10),
        classification: latest.value_classification,
        timestamp: parseInt(latest.timestamp, 10) * 1000,
      };
      this.lastFetch = now;

      return this.cache;
    } catch (error) {
      console.warn('Fear & Greed API error:', error);
      return this.cache;
    }
  }
}

