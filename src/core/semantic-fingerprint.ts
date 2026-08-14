/**
 * Moven AI — Semantic Fingerprint Layer
 *
 * Pure-math loop detection that catches "smart" loops where the agent
 * rephrases the same blocked attempt with different tool arguments.
 * All three sub-checks run in < 1ms with zero AI inference calls.
 *
 * Sub-checks:
 *   1. Goal-State Hashing    — SHA-256 of (intent + tool result). Repeating hash = loop.
 *   2. Progress Delta        — TF-IDF cosine similarity across last N reasoning steps.
 *                              similarity > threshold (default 0.92) = semantic loop.
 *   3. Entropy / Info-Gain   — Shannon entropy of unique tokens per step.
 *                              Flat entropy despite new tool calls = information stagnation.
 */

import crypto from 'crypto';

// ─── Public Types ────────────────────────────────────────────────────────────

export interface SemanticFingerprintOptions {
  /** Enable/disable the entire semantic fingerprint layer. Default: true */
  enabled?: boolean;
  /** Number of recent reasoning steps to compare. Default: 5 */
  windowSize?: number;
  /** Cosine similarity threshold above which a semantic loop is declared. Default: 0.92 */
  similarityThreshold?: number;
  /** Minimum steps needed before running similarity checks. Default: 3 */
  minStepsForCheck?: number;
  /** Entropy gain considered "near zero" (0.0–1.0 normalised). Default: 0.05 */
  minEntropyGain?: number;
}

export interface SemanticFingerprintResult {
  tripped: boolean;
  subCheck?: 'goal_state_hash' | 'progress_delta' | 'entropy_collapse';
  reason?: string;
  /** cosine similarity score of the last two windows (0.0 – 1.0) */
  similarityScore?: number;
  /** normalised entropy gain of the latest step vs window average */
  entropyGain?: number;
  /** the intent hash that repeated (for goal-state check) */
  repeatedHash?: string;
  /** processing latency in microseconds */
  latencyUs?: number;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Stop-words pruned from TF-IDF vectors to reduce noise */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'will', 'have',
  'from', 'not', 'are', 'was', 'but', 'can', 'its', 'has',
  'try', 'use', 'get', 'set', 'now', 'let', 'run',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Term-frequency map for a list of tokens.
 * Values are normalised (0–1) by document length.
 */
function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  if (tokens.length === 0) return tf;
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  for (const [k, v] of tf) {
    tf.set(k, v / tokens.length);
  }
  return tf;
}

/**
 * Cosine similarity between two TF maps sharing the same IDF weights.
 * Runs in O(|vocab|) — typically < 0.1ms for agent reasoning steps.
 */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, tfA] of a) {
    normA += tfA * tfA;
    const tfB = b.get(term) ?? 0;
    dot += tfA * tfB;
  }
  for (const tfB of b.values()) {
    normB += tfB * tfB;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Shannon entropy for a list of tokens.
 * H = -Σ p(t) * log2(p(t))
 * Normalised to [0, 1] by dividing by log2(vocab_size).
 */
function shannonEntropy(tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / tokens.length;
    entropy -= p * Math.log2(p);
  }

  const maxEntropy = Math.log2(freq.size || 1);
  return maxEntropy === 0 ? 0 : entropy / maxEntropy;
}

// ─── Main Engine ─────────────────────────────────────────────────────────────

export class SemanticFingerprintEngine {
  /**
   * Evaluate the full semantic fingerprint suite against the current reasoning window.
   *
   * @param reasoningSteps  Sliding window of recent agent reasoning/thought strings
   * @param intentHashes    Parallel array of goal-state hashes (intent + result) per step
   * @param options         Tunable thresholds
   */
  public static evaluate(
    reasoningSteps: string[],
    intentHashes: string[],
    options?: SemanticFingerprintOptions,
  ): SemanticFingerprintResult {
    if (options?.enabled === false) return { tripped: false };

    const t0 = process.hrtime.bigint();

    const windowSize = options?.windowSize ?? 5;
    const threshold = options?.similarityThreshold ?? 0.92;
    const minSteps = options?.minStepsForCheck ?? 3;
    const minEntropyGain = options?.minEntropyGain ?? 0.05;

    if (reasoningSteps.length < minSteps) {
      return { tripped: false, latencyUs: Number(process.hrtime.bigint() - t0) / 1000 };
    }

    const window = reasoningSteps.slice(-windowSize);
    const hashWindow = intentHashes.slice(-windowSize);

    // ── Sub-check 1: Goal-State Hash Repeat ──────────────────────────────
    const hashRepeat = SemanticFingerprintEngine._checkGoalStateHash(hashWindow);
    if (hashRepeat.tripped) {
      return {
        ...hashRepeat,
        latencyUs: Number(process.hrtime.bigint() - t0) / 1000,
      };
    }

    // ── Sub-check 2: Cosine Similarity Progress Delta ─────────────────────
    const deltaResult = SemanticFingerprintEngine._checkProgressDelta(window, threshold);
    if (deltaResult.tripped) {
      return {
        ...deltaResult,
        latencyUs: Number(process.hrtime.bigint() - t0) / 1000,
      };
    }

    // ── Sub-check 3: Shannon Entropy / Info-Gain Collapse ─────────────────
    const entropyResult = SemanticFingerprintEngine._checkEntropyCollapse(window, minEntropyGain);
    if (entropyResult.tripped) {
      return {
        ...entropyResult,
        latencyUs: Number(process.hrtime.bigint() - t0) / 1000,
      };
    }

    return { tripped: false, latencyUs: Number(process.hrtime.bigint() - t0) / 1000 };
  }

  // ── Public utilities ────────────────────────────────────────────────────

  /**
   * Compute and return the goal-state hash for a single step.
   * Hash = SHA-256( normalize(intent) + "|" + normalize(toolResult) )
   */
  public static computeIntentHash(intentText: string, toolResult?: any): string {
    const resultStr = toolResult === undefined
      ? ''
      : typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

    const normalised = `${intentText.trim().toLowerCase()}|${resultStr.trim().toLowerCase()}`;
    return crypto.createHash('sha256').update(normalised).digest('hex').substring(0, 20);
  }

  /**
   * Compute cosine similarity between two reasoning step strings.
   * Exposed for external use (e.g., custom checks).
   */
  public static stepSimilarity(stepA: string, stepB: string): number {
    const tfA = termFrequency(tokenize(stepA));
    const tfB = termFrequency(tokenize(stepB));
    return cosineSimilarity(tfA, tfB);
  }

  // ── Private sub-checks ───────────────────────────────────────────────────

  private static _checkGoalStateHash(hashWindow: string[]): SemanticFingerprintResult {
    if (hashWindow.length < 2) return { tripped: false };

    // A hash repeating anywhere in the window means we've been in this exact
    // (intent, result) state before — classic semantic loop.
    const seen = new Map<string, number>();
    for (let i = 0; i < hashWindow.length; i++) {
      const h = hashWindow[i];
      if (seen.has(h)) {
        return {
          tripped: true,
          subCheck: 'goal_state_hash',
          repeatedHash: h,
          reason: `Semantic Fingerprint [Goal-State Hash]: Intent+result hash "${h}" repeated at steps ${seen.get(h)} and ${i} in the current window. Agent is locked in a semantic loop despite changing tool arguments.`,
        };
      }
      seen.set(h, i);
    }
    return { tripped: false };
  }

  private static _checkProgressDelta(
    window: string[],
    threshold: number,
  ): SemanticFingerprintResult {
    if (window.length < 2) return { tripped: false };

    // Compare the first half of the window vs the second half using merged TF vectors.
    const half = Math.ceil(window.length / 2);
    const firstHalf = window.slice(0, half).join(' ');
    const secondHalf = window.slice(half).join(' ');

    const tfA = termFrequency(tokenize(firstHalf));
    const tfB = termFrequency(tokenize(secondHalf));
    const similarity = cosineSimilarity(tfA, tfB);

    if (similarity >= threshold) {
      return {
        tripped: true,
        subCheck: 'progress_delta',
        similarityScore: Number(similarity.toFixed(4)),
        reason: `Semantic Fingerprint [Progress Delta]: Cosine similarity between recent reasoning windows is ${(similarity * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(0)}%). Agent is semantically rephrasing the same blocked attempt.`,
      };
    }

    return { tripped: false, similarityScore: Number(similarity.toFixed(4)) };
  }

  private static _checkEntropyCollapse(
    window: string[],
    minEntropyGain: number,
  ): SemanticFingerprintResult {
    if (window.length < 3) return { tripped: false };

    // Compute per-step entropy and check if the latest step adds < minEntropyGain
    // relative to the rolling average of the preceding steps.
    const entropies = window.map(step => shannonEntropy(tokenize(step)));
    const avgPrev = entropies.slice(0, -1).reduce((s, e) => s + e, 0) / (entropies.length - 1);
    const latestEntropy = entropies[entropies.length - 1];
    const gain = Math.abs(latestEntropy - avgPrev);

    // Only fire if the overall entropy is not trivially low (i.e., step has content)
    const hasContent = tokenize(window[window.length - 1]).length >= 5;

    if (hasContent && gain < minEntropyGain && avgPrev > 0.1) {
      return {
        tripped: true,
        subCheck: 'entropy_collapse',
        entropyGain: Number(gain.toFixed(4)),
        reason: `Semantic Fingerprint [Entropy Collapse]: Latest reasoning step added only ${(gain * 100).toFixed(1)}% normalised entropy gain (threshold: ${(minEntropyGain * 100).toFixed(0)}%). High token output, near-zero information gain — circuit breaker tripped.`,
      };
    }

    return { tripped: false, entropyGain: Number(gain.toFixed(4)) };
  }
}
