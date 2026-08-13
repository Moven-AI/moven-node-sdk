import crypto from 'crypto';

export interface SemanticCacheOptions {
  enableSemanticCache?: boolean;    // default: true
  similarityThreshold?: number;     // default: 0.92 (92%+ similarity threshold)
  ttlSeconds?: number;              // default: 3600 (1 hour)
  maxMemorySize?: number;           // default: 500 entries in LRU memory
}

export interface CacheHitResult {
  hit: boolean;
  cachedResponse?: any;
  similarity?: number;
  tokensSaved?: number;
  costSavedDollar?: number;
}

interface CacheEntry {
  inputText: string;
  tokens: string[];
  response: any;
  timestamp: number;
  hitCount: number;
  estimatedCost: number;
}

export class MovenSemanticCacheEngine {
  private static memoryCache: Map<string, CacheEntry> = new Map();
  private static maxMemory = 500;

  /**
   * Fast local token-overlap & cosine similarity check (< 2ms)
   */
  public static lookup(
    inputText: string,
    options?: SemanticCacheOptions
  ): CacheHitResult {
    if (options?.enableSemanticCache === false) return { hit: false };
    if (!inputText || inputText.trim().length === 0) return { hit: false };

    const threshold = options?.similarityThreshold ?? 0.92;
    const queryTokens = this.tokenize(inputText);

    if (queryTokens.length === 0) return { hit: false };

    let bestMatch: CacheEntry | null = null;
    let bestSimilarity = 0;

    for (const entry of this.memoryCache.values()) {
      // Check TTL
      if (options?.ttlSeconds && (Date.now() - entry.timestamp) > options.ttlSeconds * 1000) {
        continue;
      }

      const similarity = this.jaccardCosineSimilarity(queryTokens, entry.tokens);
      if (similarity >= threshold && similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = entry;
      }
    }

    if (bestMatch && bestSimilarity >= threshold) {
      bestMatch.hitCount += 1;
      return {
        hit: true,
        cachedResponse: bestMatch.response,
        similarity: Number(bestSimilarity.toFixed(4)),
        tokensSaved: Math.round(bestMatch.inputText.length / 4) + 150,
        costSavedDollar: Number((bestMatch.estimatedCost || 0.01).toFixed(4)),
      };
    }

    return { hit: false };
  }

  /**
   * Stores a tool/LLM response in the local semantic cache
   */
  public static store(
    inputText: string,
    response: any,
    estimatedCost: number = 0.01,
    options?: SemanticCacheOptions
  ) {
    if (options?.enableSemanticCache === false) return;
    if (!inputText || !response) return;

    const hash = crypto.createHash('sha256').update(inputText.trim().toLowerCase()).digest('hex').substring(0, 16);
    const tokens = this.tokenize(inputText);

    // Evict oldest if max memory size reached
    if (this.memoryCache.size >= (options?.maxMemorySize || this.maxMemory)) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) this.memoryCache.delete(firstKey);
    }

    this.memoryCache.set(hash, {
      inputText,
      tokens,
      response,
      timestamp: Date.now(),
      hitCount: 1,
      estimatedCost,
    });
  }

  public static clearMemoryCache() {
    this.memoryCache.clear();
  }

  private static tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
  }

  private static jaccardCosineSimilarity(a: string[], b: string[]): number {
    const setA = new Set(a);
    const setB = new Set(b);

    let intersection = 0;
    for (const elem of setA) {
      if (setB.has(elem)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    if (union === 0) return 0;

    // Combined Jaccard + length penalty similarity
    const jaccard = intersection / union;
    const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);

    return jaccard * 0.7 + lenRatio * 0.3;
  }
}
