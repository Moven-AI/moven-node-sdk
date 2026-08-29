import { SemanticCanonicalizer } from './canonicalizer';
import { MovenMrlEmbedder } from './mrl-embedder';
import { SemanticMemoryManager } from './memory';
import { SemanticFeatureEngine } from './features';
import { TinySemanticClassifier } from './classifier';
import { SemanticPolicyEngine, HysteresisHolder } from './policy';
import {
  SemanticActionInput,
  Layer2DecisionResult,
  Layer2Options,
  ToolSemanticPolicy,
} from './types';

export class MovenLayer2Guard {
  public memory: SemanticMemoryManager;
  public options: Layer2Options;
  public agentId: string;
  private zeroProgressStreak: number = 0;
  /**
   * Hysteresis scoped to THIS guard instance (i.e. this run) — one bad run
   * can no longer poison future runs, and no cross-run static map leaks.
   */
  private hysteresis: HysteresisHolder = { state: 'NORMAL' };

  constructor(agentId: string = 'default_agent', options?: Layer2Options) {
    this.agentId = agentId;
    this.options = {
      enabled: true,
      mode: 'BALANCED',
      redundancyThreshold: 0.95,
      driftThreshold: 0.90,
      noveltyThreshold: 0.90,
      usefulThreshold: 0.65,
      hysteresisEnabled: true,
      blockThreshold: 0.95,
      recoverThreshold: 0.70,
      actionMemoryWindow: 32,
      factMemoryWindow: 128,
      infoCoverageCheck: true,
      pineconeSync: true,
      mrlDimensions: 128,
      ...options,
    };

    this.memory = new SemanticMemoryManager({
      maxActions: this.options.actionMemoryWindow,
      maxFacts: this.options.factMemoryWindow,
      targetDim: this.options.mrlDimensions,
    });
  }

  /**
   * Evaluates a proposed tool action directly in the runtime hot path (<0.8ms).
   */
  public evaluate(
    tool: string,
    args: Record<string, any> = {},
    goal?: string,
    expectedOutcome?: string,
    toolPolicy?: ToolSemanticPolicy,
    cost?: number
  ): Layer2DecisionResult {
    const startTime = performance.now();

    if (this.options.enabled === false) {
      return {
        decision: 'ALLOW',
        probabilities: {
          p_useful: 1.0,
          p_redundant: 0.0,
          p_goal_drift: 0.0,
          p_low_novelty: 0.0,
          p_risk: 0.0,
          combined_score: 1.0,
        },
        features: {} as any,
        reason: 'Layer 2 Semantic Guard is disabled.',
        featureAttributions: {},
        latencyUs: 5,
        cached: false,
      };
    }

    if (goal) {
      this.memory.setGoal(goal);
    }

    const hasGoal = !!(goal || (this.memory.hasExplicitGoal ? this.memory.goalState.primaryGoal : ''));
    const input: SemanticActionInput = {
      tool,
      arguments: args,
      goal: hasGoal ? (goal || this.memory.goalState.primaryGoal) : '',
      expectedOutcome,
      cost,
    };

    // 1. Canonicalize
    const canonical = SemanticCanonicalizer.canonicalize(input);

    // 2. Extract Features
    const { features } = SemanticFeatureEngine.extractFeatures(
      input,
      canonical,
      this.memory,
      toolPolicy,
      undefined,
      this.zeroProgressStreak
    );

    // 3. Predict Multi-Head Probabilities
    const { probabilities, attributions } = TinySemanticClassifier.predict(features);
    if (!hasGoal) {
      probabilities.p_goal_drift = 0.0;
    }

    // 4. Evaluate Policy
    const elapsedUs = Math.max(1, Math.round((performance.now() - startTime) * 1000));
    const result = SemanticPolicyEngine.evaluatePolicy(
      this.agentId,
      probabilities,
      features,
      attributions,
      this.options,
      toolPolicy,
      elapsedUs,
      false,
      this.hysteresis
    );

    // Track zero progress streak
    if (result.decision === 'BLOCK' || result.decision === 'REPLAN') {
      this.zeroProgressStreak += 1;
    } else {
      this.zeroProgressStreak = Math.max(0, this.zeroProgressStreak - 1);
    }

    return result;
  }

  /**
   * Records a completed tool result, extracts facts, and asynchronously pre-embeds into RAM cache.
   */
  public recordToolResult(tool: string, args: Record<string, any>, result: any): void {
    // 1. Add action to memory
    this.memory.addAction(tool, args);

    // 2. Extract facts and pre-embed immediately
    this.memory.extractFactsFromResult(tool, result);
  }
}
