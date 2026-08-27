import { SemanticEmbeddingCache } from './cache';

export class MovenMrlEmbedder {
  private static DEFAULT_DIM = 128;

  private static hashToken(str: string, seed: number = 0): number {
    let h1 = (seed ^ 0x12345678) >>> 0;
    const c1 = 0xcc9e2d51;
    const c2 = 0x1b873593;

    for (let i = 0; i < str.length; i++) {
      let k1 = str.charCodeAt(i);
      k1 = Math.imul(k1, c1);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, c2);

      h1 ^= k1;
      h1 = (h1 << 13) | (h1 >>> 19);
      h1 = Math.imul(h1, 5) + 0xe6546b64;
    }

    h1 ^= str.length;
    h1 ^= h1 >>> 16;
    h1 = Math.imul(h1, 0x85ebca6b);
    h1 ^= h1 >>> 13;
    h1 = Math.imul(h1, 0xc2b2ae35);
    h1 ^= h1 >>> 16;

    return h1 >>> 0;
  }

  public static tokenize(text: string): string[] {
    const clean = (text || '')
      .toLowerCase()
      .replace(/^(goal|action|tool|expected result|result|fact)\b/gim, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .trim();
    
    const words = clean.split(/\s+/).filter(w => w.length > 1 && w !== 'the' && w !== 'and' && w !== 'for' && w !== 'tool' && w !== 'action' && w !== 'goal');
    const tokens: string[] = [];

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      tokens.push(w);

      if (i < words.length - 1) {
        tokens.push(`${w}_${words[i + 1]}`);
      }
    }

    return tokens;
  }

  public static embed(text: string, targetDim: number = this.DEFAULT_DIM): Float32Array {
    const cached = SemanticEmbeddingCache.get(text, targetDim);
    if (cached) return cached;

    const vec = new Float32Array(targetDim);
    const tokens = this.tokenize(text);

    if (tokens.length === 0) {
      SemanticEmbeddingCache.set(text, vec, targetDim);
      return vec;
    }

    for (const token of tokens) {
      const hash1 = this.hashToken(token, 0);
      const hash2 = this.hashToken(token, 1013);

      const idx1 = hash1 % targetDim;
      const sign1 = (hash1 & 1) === 1 ? 1.0 : -1.0;

      const idx2 = hash2 % targetDim;
      const sign2 = (hash2 & 1) === 1 ? 1.0 : -1.0;

      vec[idx1] += sign1;
      vec[idx2] += sign2 * 0.5;
    }

    let norm = 0.0;
    for (let i = 0; i < targetDim; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < targetDim; i++) {
        vec[i] /= norm;
      }
    }

    SemanticEmbeddingCache.set(text, vec, targetDim);
    return vec;
  }

  public static cosineSimilarity(a: Float32Array, b: Float32Array, truncatedDim?: number): number {
    const dim = Math.min(truncatedDim || a.length, a.length, b.length);
    let dot = 0.0;
    let normA = 0.0;
    let normB = 0.0;

    for (let i = 0; i < dim; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0.0;
    const sim = dot / denom;
    return Math.max(0.0, Math.min(1.0, sim));
  }

  public static euclideanDistance(a: Float32Array, b: Float32Array, truncatedDim?: number): number {
    const dim = Math.min(truncatedDim || a.length, a.length, b.length);
    let sum = 0.0;
    for (let i = 0; i < dim; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }
}
