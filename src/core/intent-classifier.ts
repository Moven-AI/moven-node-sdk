/**
 * Moven Instruction-Intent Classifier
 *
 * A deterministic, zero-dependency lexical classifier that decides whether a
 * human message actually LICENSES tool-call repetition ("search it 5 times",
 * "poll until done", "run it again") — as opposed to any random mid-run user
 * message ("what's their PE ratio?"), which must NOT relax loop detection.
 *
 * Pipeline (runs in well under 0.1ms, fully offline):
 *   1. Feature extraction  — directive lexicon families + negation guards
 *   2. Weighted scoring    — interpretable additive score, thresholded
 *   3. Budget extraction   — explicit counts ("5 times", "twice", "x10")
 *   4. Topic attribution   — content terms used to match the directive to
 *                            the tool calls it applies to (so "poll the
 *                            build" does not attest an unrelated search)
 *
 * This is an interpretable weighted classifier (transparent features you can
 * audit), not an opaque neural model — the right trade-off for a safety
 * component that must be deterministic, testable and dependency-free.
 */

export interface InstructionClassification {
  /** True when the message contains an affirmative repetition/persistence directive. */
  isRepetitionDirective: boolean;
  /** Additive evidence score (0..1+); directive fires when >= threshold. */
  score: number;
  /** confidence = min(1, score) — exposed for logging/telemetry. */
  confidence: number;
  /** Which lexicon family triggered. */
  kind: 'explicit_count' | 'again' | 'repeat_verb' | 'persist' | 'none';
  /** Explicit repetition budget when the user stated a count ("5 times" → 5). */
  maxRepetitions?: number;
  /** Content terms used for topic→call attribution (empty ⇒ general directive). */
  topicTerms: string[];
  /** Human-readable evidence (for logs/tests). */
  evidence?: string;
}

/** Lexicon families — each match adds its weight to the directive score. */
const LEXICON: { kind: InstructionClassification['kind']; weight: number; patterns: RegExp[] }[] = [
  {
    // "search it 5 times", "run it twice", "x10", "try 3 more times"
    kind: 'explicit_count',
    weight: 0.6,
    patterns: [
      /\b\d+\s*(?:x|times|reps|repetitions|runs|tries|attempts|iterations)\b/i,
      /\bx\s?\d+\b/i,
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|couple(?:\s+of)?|few|dozen)\s+(?:more\s+)?times\b/i,
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+more\b/i,
    ],
  },
  {
    // "again", "once more", "retry", "rerun", "re-run", "requery"
    kind: 'again',
    weight: 0.55,
    patterns: [
      /\b(?:again|once\s+more|one\s+more\s+(?:time|go|round)|retry|re-?run|re-?query|re-?check|re-?do|rerun)\b/i,
    ],
  },
  {
    // "repeat", "keep doing", "refresh", "revalidate"
    kind: 'repeat_verb',
    weight: 0.55,
    patterns: [
      /\b(?:repeat|repeating|repeatedly|keep\s+(?:doing|going|searching|checking|polling|running|trying|refreshing)|refresh|revalidate)\b/i,
    ],
  },
  {
    // "poll until done", "watch the build", "monitor every 30s", "continue until"
    kind: 'persist',
    weight: 0.55,
    patterns: [
      /\b(?:poll(?:ing)?|watch|monitor|wait\s+for|continue\s+until|until\s+(?:it|the|done|complete|finished|ready|success)|keep\s+going\s+until|in\s+a\s+loop|loop\s+until|every\s+\d+\s*(?:s|sec|secs|seconds|m|min|mins|minutes)?)\b/i,
    ],
  },
];

/**
 * Negation / revocation guards: a message that tells the agent to STOP
 * repeating must CLOSE the attestation, not open one. "Only once" is a
 * count-1 directive, not a negation.
 */
const NEGATION_PATTERNS: RegExp[] = [
  /\b(?:don'?t|do\s+not|never|stop|no\s+more|quit)\b[^.;]*\b(?:repeat|search|poll|loop|run|do|try|check|call)\b/i,
  /\bstop\s+(?:searching|polling|looping|repeating|trying|running|doing)/i,
  /\bno\s+more\s+(?:searching|polling|retries|loops|repeats|calls)/i,
];

/** Words that never count as topic terms (function words + directive words). */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'with', 'it', 'its', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'done', 'please', 'can', 'you', 'i', 'we',
  'again', 'more', 'once', 'time', 'times', 'repeat', 'repeatedly', 'retry', 'rerun', 'recheck', 'refresh',
  'keep', 'continue', 'until', 'while', 'every', 'poll', 'polling', 'watch', 'monitor', 'then', 'now',
  'just', 'only', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'x',
  'few', 'couple', 'dozen', 'going', 'doing', 'trying', 'checking', 'searching', 'running', 'waiting',
]);

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, twenty: 20, couple: 2, few: 3, dozen: 12,
};

/** Tokenizes text into lowercase content terms ([a-z0-9], split on _ and -). */
export function tokenizeTerms(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/[\s_\-]+/)
    .filter((t) => t.length > 1);
}

/** Content terms of an instruction (stopwords + directive words removed). */
export function extractTopicTerms(instruction: string): string[] {
  return Array.from(new Set(tokenizeTerms(instruction).filter((t) => !STOPWORDS.has(t))));
}

/** Content terms of a tool call (tool name words + query-ish argument strings). */
export function extractCallTerms(toolName: string, args: unknown, queryStringOf?: (args: any) => string): string[] {
  const queryPart = queryStringOf ? queryStringOf(args) : '';
  return Array.from(new Set([
    ...tokenizeTerms(toolName),
    ...tokenizeTerms(queryPart),
  ]));
}

/** Jaccard overlap between two term sets (0..1). */
export function termOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let inter = 0;
  for (const t of new Set(a)) {
    if (setB.has(t)) inter += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

function extractCount(text: string): number | undefined {
  const digit = text.match(/\b(\d+)\s*(?:x|times|reps|repetitions|runs|tries|attempts|iterations)\b/i)
    || text.match(/\bx\s?(\d+)\b/i);
  if (digit) {
    const n = parseInt(digit[1], 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 100);
  }
  const word = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|couple|few|dozen)\s+(?:more\s+)?times\b/i);
  if (word) {
    const n = NUMBER_WORDS[word[1].toLowerCase()];
    if (n) return n;
  }
  const wordMore = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+more\b/i);
  if (wordMore) {
    const n = NUMBER_WORDS[wordMore[1].toLowerCase()];
    if (n) return n;
  }
  // "only once" / "just once" — an explicit count of 1
  if (/\b(?:only|just)\s+once\b/i.test(text)) return 1;
  return undefined;
}

export class MovenInstructionClassifier {
  /**
   * Classifies a human message for repetition licensing.
   * @param threshold minimum score for a directive (default 0.5 — one strong
   *        lexicon family alone passes; two partial hints combine to pass).
   */
  public static classify(instruction: string, threshold: number = 0.5): InstructionClassification {
    const text = (instruction || '').slice(0, 500); // bound the hot path
    if (!text.trim()) {
      return { isRepetitionDirective: false, score: 0, confidence: 0, kind: 'none', topicTerms: [] };
    }

    // 1. Negation / revocation guard — must win over everything else.
    for (const p of NEGATION_PATTERNS) {
      if (p.test(text)) {
        return {
          isRepetitionDirective: false,
          score: 0,
          confidence: 0,
          kind: 'none',
          topicTerms: extractTopicTerms(text),
          evidence: 'negation/stop guard matched',
        };
      }
    }

    // 2. Weighted lexicon scoring.
    let score = 0;
    let kind: InstructionClassification['kind'] = 'none';
    const matched: string[] = [];
    for (const family of LEXICON) {
      for (const p of family.patterns) {
        if (p.test(text)) {
          score += family.weight;
          matched.push(family.kind);
          if (kind === 'none' || family.kind === 'explicit_count') kind = family.kind;
          break; // one hit per family is enough evidence
        }
      }
    }

    // 3. Threshold decision.
    const isDirective = score >= threshold;
    const maxRepetitions = isDirective ? extractCount(text) : undefined;

    return {
      isRepetitionDirective: isDirective,
      score: Number(score.toFixed(2)),
      confidence: Math.min(1, Number(score.toFixed(2))),
      kind: isDirective ? kind : 'none',
      maxRepetitions,
      topicTerms: extractTopicTerms(text),
      evidence: matched.length > 0 ? `matched: ${matched.join('+')}` : undefined,
    };
  }
}
