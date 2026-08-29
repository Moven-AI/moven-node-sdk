import { ToolCallLog } from './run-state';
import { safeStringify } from './safe-json';

export type ToolIntentCategory = 'EXPLORATORY' | 'MUTATING' | 'POLLING' | 'COMPUTATIONAL';

export interface AdaptiveLoopEvaluation {
  tripped: boolean;
  heuristic?: 'stagnant_query_thrashing' | 'oscillation_cycle_detected' | 'information_gain_collapse' | 'mutating_tool_repeat_exceeded';
  reason?: string;
  category: ToolIntentCategory;
  noveltyScore: number;
  entropyGain: number;
  cycleLength?: number;
  consecutiveCount: number;
  isLegitimateExploration: boolean;
}

export class MovenAdaptiveLoopEngine {
  /**
   * Categorizes a tool into its semantic intent category based on name and prefixes.
   */
  public static categorizeTool(toolName: string): ToolIntentCategory {
    const lower = (toolName || '').toLowerCase().trim();

    // 1. Polling Tools
    if (
      lower.includes('poll') ||
      lower.includes('wait_for') ||
      lower.includes('check_status') ||
      lower.includes('get_job_status') ||
      lower.includes('check_build')
    ) {
      return 'POLLING';
    }

    // 2. Mutating / High-Impact Tools
    if (
      lower.startsWith('write_') ||
      lower.startsWith('edit_') ||
      lower.startsWith('delete_') ||
      lower.startsWith('remove_') ||
      lower.startsWith('create_') ||
      lower.startsWith('post_') ||
      lower.startsWith('send_') ||
      lower.startsWith('charge_') ||
      lower.startsWith('execute_') ||
      lower.startsWith('deploy_') ||
      lower.startsWith('update_') ||
      lower.startsWith('patch_') ||
      lower.includes('transfer') ||
      lower.includes('database_mutation')
    ) {
      return 'MUTATING';
    }

    // 3. Exploratory Tools (Web Search, File Read, Doc Query, Browser, Code Inspection)
    if (
      lower.includes('search') ||
      lower.includes('web') ||
      lower.includes('query') ||
      lower.includes('read') ||
      lower.includes('fetch') ||
      lower.includes('get') ||
      lower.includes('list') ||
      lower.includes('browse') ||
      lower.includes('inspect') ||
      lower.includes('find') ||
      lower.includes('grep') ||
      lower.includes('scrape') ||
      lower.includes('lookup')
    ) {
      return 'EXPLORATORY';
    }

    // 4. Default to Computational
    return 'COMPUTATIONAL';
  }

  /**
   * Tokenizes text and produces a set of normalized unigrams and bigrams.
   */
  public static extractNgrams(text: string): Set<string> {
    const tokens = (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9_\-\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);

    const ngrams = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
      ngrams.add(tokens[i]);
      if (i < tokens.length - 1) {
        ngrams.add(`${tokens[i]}_${tokens[i + 1]}`);
      }
    }
    return ngrams;
  }

  /**
   * Computes Jaccard Novelty Divergence score between two query texts (0.0 = identical, 1.0 = completely novel).
   */
  public static computeQueryNoveltyScore(textA: string, textB: string): number {
    const setA = this.extractNgrams(textA);
    const setB = this.extractNgrams(textB);

    if (setA.size === 0 && setB.size === 0) return 0.0;
    if (setA.size === 0 || setB.size === 0) return 1.0;

    let intersectionCount = 0;
    for (const item of setA) {
      if (setB.has(item)) intersectionCount++;
    }

    const unionCount = setA.size + setB.size - intersectionCount;
    const similarity = intersectionCount / (unionCount || 1);
    
    // Novelty is the inverse of similarity
    return Math.max(0.0, Math.min(1.0, 1.0 - similarity));
  }

  /**
   * Serializes tool arguments into a readable string for novelty comparison.
   */
  public static extractQueryString(args: any): string {
    if (!args) return '';
    if (typeof args === 'string') return args;
    if (typeof args === 'object') {
      if (typeof args.query === 'string') return args.query;
      if (typeof args.q === 'string') return args.q;
      if (typeof args.prompt === 'string') return args.prompt;
      if (typeof args.url === 'string') return args.url;
      if (typeof args.path === 'string') return args.path;
      if (typeof args.search_term === 'string') return args.search_term;
      return safeStringify(args);
    }
    return String(args);
  }

  /**
   * Detects cyclic oscillations (e.g. A -> B -> A -> B -> A -> B or A -> B -> C -> A -> B -> C).
   */
  public static detectOscillationCycle(toolCalls: ToolCallLog[]): { isOscillating: boolean; cycleLength?: number; pattern?: string[] } {
    if (toolCalls.length < 4) return { isOscillating: false };

    const names = toolCalls.map(c => c.toolName);
    const recent = names.slice(-8);

    // Check for 2-cycle (A, B, A, B, A, B)
    if (recent.length >= 4) {
      const p1 = recent[recent.length - 1];
      const p2 = recent[recent.length - 2];
      const p3 = recent[recent.length - 3];
      const p4 = recent[recent.length - 4];

      if (p1 === p3 && p2 === p4 && p1 !== p2) {
        if (recent.length >= 6) {
          const p5 = recent[recent.length - 5];
          const p6 = recent[recent.length - 6];
          if (p5 === p1 && p6 === p2) {
            return { isOscillating: true, cycleLength: 2, pattern: [p2, p1] };
          }
        }
      }
    }

    // Check for 3-cycle (A, B, C, A, B, C)
    if (recent.length >= 6) {
      const len = recent.length;
      if (
        recent[len - 1] === recent[len - 4] &&
        recent[len - 2] === recent[len - 5] &&
        recent[len - 3] === recent[len - 6] &&
        (recent[len - 1] !== recent[len - 2] || recent[len - 2] !== recent[len - 3])
      ) {
        return { isOscillating: true, cycleLength: 3, pattern: [recent[len - 3], recent[len - 2], recent[len - 1]] };
      }
    }

    return { isOscillating: false };
  }

  /**
   * Computes approximate Shannon entropy / information content of observation result.
   */
  public static calculateObservationEntropy(result: any): number {
    if (result === null || result === undefined) return 0.0;

    let text = '';
    if (typeof result === 'string') {
      text = result;
    } else if (typeof result === 'object') {
      text = safeStringify(result);
    } else {
      text = String(result);
    }

    // If empty result or error payload
    if (text.length < 5 || text === '[]' || text === '{}' || text.includes('Error:') || text.includes('not found')) {
      return 0.01;
    }

    // Frequency map of characters
    const freqs: Record<string, number> = {};
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      freqs[char] = (freqs[char] || 0) + 1;
    }

    let entropy = 0.0;
    const len = text.length;
    for (const char in freqs) {
      const p = freqs[char] / len;
      entropy -= p * Math.log2(p);
    }

    return Number((entropy / 8.0).toFixed(4)); // Normalized 0–1
  }

  /**
   * Main Evaluation Entrypoint:
   * Analyzes the tool history and distinguishes valid multi-step exploration from true runaway loops.
   */
  public static evaluate(
    toolCalls: ToolCallLog[],
    customExplorationCap: number = 15
  ): AdaptiveLoopEvaluation {
    if (toolCalls.length === 0) {
      return {
        tripped: false,
        category: 'COMPUTATIONAL',
        noveltyScore: 1.0,
        entropyGain: 1.0,
        consecutiveCount: 0,
        isLegitimateExploration: true,
      };
    }

    const lastCall = toolCalls[toolCalls.length - 1];
    const category = this.categorizeTool(lastCall.toolName);

    // 1. Check for Multi-Tool Cycle Oscillations (e.g. search -> click -> search -> click)
    const oscillation = this.detectOscillationCycle(toolCalls);
    if (oscillation.isOscillating) {
      return {
        tripped: true,
        heuristic: 'oscillation_cycle_detected',
        reason: `Oscillating cycle detected: pattern [${oscillation.pattern?.join(' -> ')}] repeated with 0% state convergence.`,
        category,
        noveltyScore: 0.02,
        entropyGain: 0.01,
        cycleLength: oscillation.cycleLength,
        consecutiveCount: toolCalls.length,
        isLegitimateExploration: false,
      };
    }

    // 2. Filter calls to the same tool
    const sameToolCalls = toolCalls.filter(c => c.toolName === lastCall.toolName);
    const consecutiveCount = sameToolCalls.length;

    // 3. For MUTATING tools, enforce strict repeat ceilings (max 3 total side-effecting calls per run)
    if (category === 'MUTATING') {
      if (consecutiveCount >= 3) {
        return {
          tripped: true,
          heuristic: 'mutating_tool_repeat_exceeded',
          reason: `Mutating tool '${lastCall.toolName}' called ${consecutiveCount} times during this run. Side-effect cap tripped to protect database/external integrity.`,
          category,
          noveltyScore: 0.0,
          entropyGain: 0.0,
          consecutiveCount,
          isLegitimateExploration: false,
        };
      }
      return {
        tripped: false,
        category,
        noveltyScore: 1.0,
        entropyGain: 1.0,
        consecutiveCount,
        isLegitimateExploration: false,
      };
    }

    // 4. For EXPLORATORY tools (e.g. search_web, fetch_page, grep_search), evaluate novelty drift!
    if (category === 'EXPLORATORY') {
      if (sameToolCalls.length >= 2) {
        const prevCall = sameToolCalls[sameToolCalls.length - 2];
        const currentQuery = this.extractQueryString(lastCall.args);
        const prevQuery = this.extractQueryString(prevCall.args);

        const noveltyScore = this.computeQueryNoveltyScore(currentQuery, prevQuery);

        // Minimum novelty vs ALL previous queries made with this tool — not
        // just the last one. Closes the alternating-query evasion where
        // A,B,A,B novelty-vs-prev oscillates 1.0/0.0: revisiting an older
        // query is thrashing regardless of what came immediately before.
        let minNovelty = noveltyScore;
        for (let i = 0; i < sameToolCalls.length - 1; i++) {
          const olderQuery = this.extractQueryString(sameToolCalls[i].args);
          const n = this.computeQueryNoveltyScore(currentQuery, olderQuery);
          if (n < minNovelty) minNovelty = n;
        }

        const lastEntropy = this.calculateObservationEntropy(lastCall.result);
        const prevEntropy = this.calculateObservationEntropy(prevCall.result);
        // Two consecutive near-empty observations carry zero information —
        // treat as zero gain instead of a meaningless |Δ| of tiny numbers.
        const entropyGain = (lastEntropy < 0.05 && prevEntropy < 0.05)
          ? 0.0
          : Number(Math.abs(lastEntropy - prevEntropy).toFixed(4));

        // IF NOVELTY SCORE >= 0.22: The agent is asking distinctly DIFFERENT queries!
        // E.g. Query 1: "Tesla revenue 2024", Query 2: "Tesla operating margin", Query 3: "Tesla guidance 2026"
        // This is 100% legitimate research / multi-step search, allow up to customExplorationCap (default: 15)
        if (noveltyScore >= 0.22) {
          if (consecutiveCount >= customExplorationCap) {
            return {
              tripped: true,
              heuristic: 'stagnant_query_thrashing',
              reason: `Exploratory tool '${lastCall.toolName}' reached hard discovery cap (${customExplorationCap} queries). Session budget preserved.`,
              category,
              noveltyScore,
              entropyGain,
              consecutiveCount,
              isLegitimateExploration: true,
            };
          }

          // Legitimate exploration permitted!
          return {
            tripped: false,
            category,
            noveltyScore,
            entropyGain,
            consecutiveCount,
            isLegitimateExploration: true,
          };
        }

        // IF NOVELTY < 0.15: The agent is repeating virtually identical search queries!
        // E.g. "how to refund ticket", "how to refund ticket", "how to refund ticket"
        // Also trips when the agent revisits ANY older query (minNovelty),
        // which catches alternating-query loops that evade prev-only checks.
        if (consecutiveCount >= 3 && (noveltyScore < 0.15 || minNovelty < 0.15)) {
          const overlapPct = ((1 - (noveltyScore < 0.15 ? noveltyScore : minNovelty)) * 100).toFixed(0);
          return {
            tripped: true,
            heuristic: 'stagnant_query_thrashing',
            reason: `Stagnant query loop on '${lastCall.toolName}': ${consecutiveCount} calls with ${overlapPct}% query overlap and 0% discovery progression.`,
            category,
            noveltyScore,
            entropyGain,
            consecutiveCount,
            isLegitimateExploration: false,
          };
        }

        // Ambiguous band (0.15 ≤ novelty < 0.22) or insufficient repeats:
        // allow, but surface the REAL novelty/entropy scores (never fake 1.0).
        return {
          tripped: false,
          category,
          noveltyScore,
          entropyGain,
          consecutiveCount,
          isLegitimateExploration: true,
        };
      }

      return {
        tripped: false,
        category,
        noveltyScore: 1.0,
        entropyGain: 1.0,
        consecutiveCount,
        isLegitimateExploration: true,
      };
    }

    // 5. Computational / Default Tool fallback
    return {
      tripped: false,
      category,
      noveltyScore: 1.0,
      entropyGain: 1.0,
      consecutiveCount,
      isLegitimateExploration: false,
    };
  }
}
