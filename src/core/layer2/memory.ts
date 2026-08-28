import { MovenMrlEmbedder } from './mrl-embedder';
import { SemanticCanonicalizer } from './canonicalizer';
import { safeStringify } from '../safe-json';

export interface ActionMemoryEntry {
  tool: string;
  arguments: Record<string, any>;
  canonicalText: string;
  vector: Float32Array;
  timestamp: number;
}

export interface FactMemoryEntry {
  factText: string;
  canonicalText: string;
  vector: Float32Array;
  timestamp: number;
}

export interface GoalMemoryState {
  primaryGoal: string;
  canonicalGoal: string;
  goalVector: Float32Array;
  subgoals: string[];
  subgoalVectors: Float32Array[];
  requiredItems: string[];
  satisfiedItems: Set<string>;
}

export class SemanticMemoryManager {
  private maxActions: number;
  private maxFacts: number;
  private targetDim: number;

  public actions: ActionMemoryEntry[] = [];
  public facts: FactMemoryEntry[] = [];
  public goalState: GoalMemoryState;
  public stateSnapshots: Float32Array[] = [];

  constructor(options?: { maxActions?: number; maxFacts?: number; targetDim?: number }) {
    this.maxActions = options?.maxActions ?? 32;
    this.maxFacts = options?.maxFacts ?? 128;
    this.targetDim = options?.targetDim ?? 128;

    const defaultGoal = 'Complete requested task';
    this.goalState = {
      primaryGoal: defaultGoal,
      canonicalGoal: SemanticCanonicalizer.canonicalGoal(defaultGoal),
      goalVector: MovenMrlEmbedder.embed(SemanticCanonicalizer.canonicalGoal(defaultGoal), this.targetDim),
      subgoals: [],
      subgoalVectors: [],
      requiredItems: [],
      satisfiedItems: new Set(),
    };
  }

  public setGoal(goalText: string, subgoals: string[] = [], requiredItems: string[] = []): void {
    if (this.goalState && this.goalState.primaryGoal === goalText && subgoals.length === 0 && requiredItems.length === 0) {
      return;
    }

    const canonical = SemanticCanonicalizer.canonicalGoal(goalText);
    const vector = MovenMrlEmbedder.embed(canonical, this.targetDim);

    const subgoalVectors = subgoals.map(sg =>
      MovenMrlEmbedder.embed(SemanticCanonicalizer.canonicalGoal(sg), this.targetDim)
    );

    const inferredRequirements = requiredItems.length > 0
      ? requiredItems
      : this.inferRequirementsFromGoal(goalText);

    const satisfiedItems = new Set<string>(this.goalState?.satisfiedItems || []);
    for (const fact of this.facts) {
      const lowerFact = fact.factText.toLowerCase();
      for (const req of inferredRequirements) {
        if (lowerFact.includes(req.toLowerCase())) {
          satisfiedItems.add(req);
        }
      }
    }

    this.goalState = {
      primaryGoal: goalText,
      canonicalGoal: canonical,
      goalVector: vector,
      subgoals,
      subgoalVectors,
      requiredItems: inferredRequirements,
      satisfiedItems,
    };
  }

  private inferRequirementsFromGoal(goalText: string): string[] {
    const lower = (goalText || '').toLowerCase();
    const requirements: string[] = [];
    if (lower.includes('email')) requirements.push('email');
    if (lower.includes('phone') || lower.includes('telephone')) requirements.push('phone');
    if ((lower.includes('physical address') || lower.includes('postal address') || lower.includes('location') || (lower.includes('address') && !lower.includes('email address') && !lower.includes('ip address')))) {
      requirements.push('address');
    }
    if (lower.includes('price') || lower.includes('cost') || lower.includes('budget')) requirements.push('price');
    if (lower.includes('status') || lower.includes('state')) requirements.push('status');
    if (lower.includes('user_id') || lower.includes('account_id')) requirements.push('identity');
    return requirements.length > 0 ? Array.from(new Set(requirements)) : ['general_task'];
  }

  public addAction(tool: string, args: Record<string, any> = {}, precomputedVector?: Float32Array): ActionMemoryEntry {
    const canonical = SemanticCanonicalizer.canonicalAction(tool, args);
    const vector = precomputedVector || MovenMrlEmbedder.embed(canonical, this.targetDim);

    const entry: ActionMemoryEntry = {
      tool,
      arguments: args,
      canonicalText: canonical,
      vector,
      timestamp: Date.now(),
    };

    this.actions.push(entry);
    if (this.actions.length > this.maxActions) {
      this.actions.shift();
    }

    return entry;
  }

  public addFact(factText: string, precomputedVector?: Float32Array): FactMemoryEntry {
    const canonical = SemanticCanonicalizer.canonicalFact(factText);
    const vector = precomputedVector || MovenMrlEmbedder.embed(canonical, this.targetDim);

    const entry: FactMemoryEntry = {
      factText,
      canonicalText: canonical,
      vector,
      timestamp: Date.now(),
    };

    const lowerFact = factText.toLowerCase();
    for (const req of this.goalState.requiredItems) {
      if (lowerFact.includes(req.toLowerCase())) {
        this.goalState.satisfiedItems.add(req);
      }
    }

    this.facts.push(entry);
    if (this.facts.length > this.maxFacts) {
      this.facts.shift();
    }

    return entry;
  }

  /**
   * Asynchronously parses result, stores facts, and pre-embeds into cache.
   */
  public extractFactsFromResult(tool: string, result: any): string[] {
    const extracted: string[] = [];
    if (!result) return extracted;

    if (typeof result === 'string') {
      const trimmed = result.trim();
      if (trimmed.length > 0 && trimmed.length < 500) {
        extracted.push(`${tool}_output: ${trimmed}`);
      }
    } else if (typeof result === 'object' && result !== null) {
      for (const [k, v] of Object.entries(result)) {
        if (v !== undefined && v !== null && typeof v !== 'function') {
          const vStr = typeof v === 'object' ? safeStringify(v) : String(v);
          if (vStr.length < 300) {
            extracted.push(`${tool}.${k} = ${vStr}`);
          }
        }
      }
    }

    for (const fact of extracted) {
      this.addFact(fact);
    }

    this.captureStateSnapshot();
    return extracted;
  }

  public captureStateSnapshot(): Float32Array {
    const compositeVec = new Float32Array(this.targetDim);
    if (this.facts.length === 0) {
      this.stateSnapshots.push(compositeVec);
      return compositeVec;
    }

    const recentFacts = this.facts.slice(-8);
    for (const fact of recentFacts) {
      for (let i = 0; i < this.targetDim; i++) {
        compositeVec[i] += fact.vector[i] / recentFacts.length;
      }
    }

    this.stateSnapshots.push(compositeVec);
    if (this.stateSnapshots.length > 20) {
      this.stateSnapshots.shift();
    }

    return compositeVec;
  }

  public getCoverageScore(): { before: number; satisfied: string[]; totalRequired: number } {
    const total = this.goalState.requiredItems.length;
    if (total === 0) {
      const pseudoCoverage = Math.min(1.0, this.facts.length / 5);
      return { before: pseudoCoverage, satisfied: [], totalRequired: 0 };
    }
    const satisfiedCount = this.goalState.satisfiedItems.size;
    return {
      before: satisfiedCount / total,
      satisfied: Array.from(this.goalState.satisfiedItems),
      totalRequired: total,
    };
  }
}
