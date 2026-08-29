import {
  DecisionType,
  ModelHeadProbabilities,
  SemanticFeatureVector,
  Layer2DecisionResult,
  Layer2Options,
  ToolSemanticPolicy,
} from './types';

export type HysteresisState = 'NORMAL' | 'INTERVENTION';

/** Mutable holder so callers can scope hysteresis to a run instead of the process. */
export interface HysteresisHolder {
  state: HysteresisState;
}

export class SemanticPolicyEngine {
  /**
   * @deprecated Process-wide fallback. Hysteresis should be scoped per run —
   * pass a HysteresisHolder from the guard instance instead. The static map
   * leaks memory in long-lived processes and lets one bad run poison every
   * future run of the same agentId.
   */
  private static activeHysteresisState: Map<string, HysteresisState> = new Map();

  public static evaluatePolicy(
    agentId: string,
    probabilities: ModelHeadProbabilities,
    features: SemanticFeatureVector,
    attributions: Record<string, number>,
    options?: Layer2Options,
    toolPolicy?: ToolSemanticPolicy,
    latencyUs: number = 250,
    cached: boolean = false,
    hysteresis?: HysteresisHolder
  ): Layer2DecisionResult {
    const redundancyThreshold = options?.redundancyThreshold ?? 0.95;
    const driftThreshold = options?.driftThreshold ?? 0.90;
    const lowNoveltyThreshold = options?.noveltyThreshold ?? 0.90;
    const usefulThreshold = options?.usefulThreshold ?? 0.65;
    const blockThreshold = options?.blockThreshold ?? 0.95;
    const recoverThreshold = options?.recoverThreshold ?? 0.70;
    const hysteresisEnabled = options?.hysteresisEnabled ?? true;

    const currentState = hysteresis ? hysteresis.state : (this.activeHysteresisState.get(agentId) || 'NORMAL');
    let nextState = currentState;

    let decision: DecisionType = 'ALLOW';
    let reason = 'Action predicted to produce useful progress toward objective';

    if (probabilities.p_goal_drift > driftThreshold) {
      decision = 'REPLAN';
      reason = `[Goal Drift Intercepted] Action deviates significantly from active goal (P(drift) = ${probabilities.p_goal_drift}). Recommend agent reconsideration.`;
      nextState = 'INTERVENTION';
    } else if (probabilities.p_redundant > redundancyThreshold) {
      decision = 'BLOCK';
      reason = `[Redundant Action Blocked] Requested information is already available or tool call is semantically identical (P(redundant) = ${probabilities.p_redundant}).`;
      nextState = 'INTERVENTION';
    } else if (probabilities.p_redundant >= 0.88 && probabilities.p_low_novelty >= 0.88) {
      decision = 'REPLAN';
      reason = `[Redundant Information Intercepted] The requested information is already available in known facts (P(redundant) = ${probabilities.p_redundant}). Reconsider whether another search is necessary.`;
      nextState = 'INTERVENTION';
    } else if (probabilities.p_low_novelty > lowNoveltyThreshold && probabilities.p_useful < 0.25) {
      decision = 'REPLAN';
      reason = `[Information Stagnation] Proposed action produces near-zero semantic novelty and low expected utility (P(low_novelty) = ${probabilities.p_low_novelty}, P(useful) = ${probabilities.p_useful}).`;
      nextState = 'INTERVENTION';
    } else if (probabilities.p_risk > 0.88 && probabilities.p_useful < 0.40) {
      decision = 'WARN';
      reason = `[High-Risk Mutation Warning] Action has high destructive blast radius with uncertain goal alignment (P(risk) = ${probabilities.p_risk}).`;
    } else if (probabilities.p_useful >= usefulThreshold) {
      decision = 'ALLOW';
      reason = `[Useful Action Allowed] Action has high semantic novelty and expected information coverage (P(useful) = ${probabilities.p_useful}).`;
      if (currentState === 'INTERVENTION' && probabilities.p_useful >= recoverThreshold) {
        nextState = 'NORMAL';
      }
    } else {
      if (hysteresisEnabled && currentState === 'INTERVENTION') {
        if (probabilities.p_useful < recoverThreshold && (probabilities.p_redundant > 0.70 || probabilities.p_goal_drift > 0.70)) {
          decision = 'REPLAN';
          reason = `[Hysteresis Held] System remains in intervention recovery state until higher evidence of progress is shown.`;
        } else {
          decision = 'ALLOW';
          reason = `[Uncertainty Pass] Ambiguous action allowed by default to prevent false intervention (<0.1% target).`;
          nextState = 'NORMAL';
        }
      } else {
        decision = 'ALLOW';
        reason = `[Default Allow] Action allowed under uncertainty to guarantee runtime progress.`;
      }
    }

    if (hysteresisEnabled) {
      if (hysteresis) {
        hysteresis.state = nextState;
      } else {
        this.activeHysteresisState.set(agentId, nextState);
      }
    }

    return {
      decision,
      probabilities,
      features,
      reason,
      featureAttributions: attributions,
      latencyUs,
      cached,
      activeHysteresisState: nextState,
    };
  }

  /** @deprecated Use per-run HysteresisHolder scopes instead. */
  public static resetHysteresis(agentId: string): void {
    this.activeHysteresisState.delete(agentId);
  }
}
