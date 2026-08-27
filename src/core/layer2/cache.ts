import crypto from 'crypto';

export class SemanticEmbeddingCache {
  private static cache: Map<string, Float32Array> = new Map();
  private static MAX_CACHE_SIZE = 5000;

  public static get(canonicalText: string, dim: number = 128): Float32Array | undefined {
    const key = `${dim}::${crypto.createHash('sha256').update(canonicalText || '').digest('hex')}`;
    return this.cache.get(key);
  }

  public static set(canonicalText: string, vector: Float32Array, dim: number = 128): void {
    const key = `${dim}::${crypto.createHash('sha256').update(canonicalText || '').digest('hex')}`;
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, vector);
  }

  public static has(canonicalText: string, dim: number = 128): boolean {
    const key = `${dim}::${crypto.createHash('sha256').update(canonicalText || '').digest('hex')}`;
    return this.cache.has(key);
  }

  public static clear(): void {
    this.cache.clear();
  }

  public static size(): number {
    return this.cache.size;
  }
}
