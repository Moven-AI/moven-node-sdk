import { MovenMrlEmbedder } from './mrl-embedder';
import { SemanticCanonicalizer } from './canonicalizer';
import { SemanticMemoryManager } from './memory';
import { SemanticActionInput, CanonicalAction, SemanticFeatureVector, ToolSemanticPolicy } from './types';

export class SemanticFeatureEngine {
  public static extractFeatures(
    input: SemanticActionInput,
    canonical: CanonicalAction,
    memory: SemanticMemoryManager,
    policy?: ToolSemanticPolicy,
    historicalStats?: { count: number; useful: number },
    zeroProgressStreak: number = 0,
    sessionBudgetDollar: number = 5.0
  ): { features: SemanticFeatureVector; proposedActionVector: Float32Array; expectedResultVector: Float32Array } {
    const targetDim = 128;

    const proposedActionVector = MovenMrlEmbedder.embed(canonical.canonicalActionText, targetDim);
    const expectedResultVector = MovenMrlEmbedder.embed(canonical.canonicalExpectedResult, targetDim);

    // 1. Goal Similarity (default to 1.0 when no goal is provided to prevent false drift trip)
    const hasGoal = !!(input.goal || memory.goalState.primaryGoal);
    const goal_similarity = hasGoal
      ? MovenMrlEmbedder.cosineSimilarity(
          proposedActionVector,
          memory.goalState.goalVector,
          targetDim
        )
      : 1.0;

    // 2. Action Similarity Distribution
    let action_similarity_max = 0.0;
    let action_similarity_sum = 0.0;

    if (memory.actions.length > 0) {
      for (const act of memory.actions) {
        const sim = MovenMrlEmbedder.cosineSimilarity(proposedActionVector, act.vector, targetDim);
        if (sim > action_similarity_max) action_similarity_max = sim;
        action_similarity_sum += sim;
      }
    }
    const action_similarity_mean = memory.actions.length > 0
      ? action_similarity_sum / memory.actions.length
      : 0.0;

    // 3. Fact Similarity Distribution
    let fact_similarity_max = 0.0;
    let fact_similarity_sum = 0.0;

    const pureExpected = (input.expectedOutcome || canonical.canonicalExpectedResult || '')
      .replace(/^EXPECTED RESULT\n?/i, '')
      .trim();

    if (memory.facts.length > 0) {
      const pureExpectedVec = MovenMrlEmbedder.embed(pureExpected, targetDim);
      for (const fact of memory.facts) {
        const pureFact = fact.factText.replace(/^FACT\n?/i, '').trim();
        const pureFactVec = MovenMrlEmbedder.embed(pureFact, targetDim);
        const sim = MovenMrlEmbedder.cosineSimilarity(pureExpectedVec, pureFactVec, targetDim);
        if (sim > fact_similarity_max) fact_similarity_max = sim;
        fact_similarity_sum += sim;
      }
    }
    const fact_similarity_mean = memory.facts.length > 0
      ? fact_similarity_sum / memory.facts.length
      : 0.0;

    // Attribute Overlap with Known Facts
    let maxAttrOverlap = 0.0;
    if (canonical.attributeTokens.length > 0 && memory.facts.length > 0) {
      for (const fact of memory.facts) {
        const factLower = fact.factText.toLowerCase();
        for (const attr of canonical.attributeTokens) {
          const attrLower = attr.toLowerCase().replace(/^[a-z_]+:/, '');
          if (attrLower && factLower.includes(attrLower)) {
            maxAttrOverlap = Math.max(maxAttrOverlap, 0.96);
          }
        }
      }
    }

    if (maxAttrOverlap > 0.8) {
      fact_similarity_max = Math.max(fact_similarity_max, maxAttrOverlap);
    }

    // 4. Multi-Dimensional Novelty
    let novelty = Math.max(0.0, 1.0 - fact_similarity_max);
    const attribute_novelty = Math.max(0.0, 1.0 - maxAttrOverlap);

    // If goal coverage is already 100% and attribute is already satisfied, novelty is near 0
    const coverage = memory.getCoverageScore();
    if (coverage.before >= 1.0 && maxAttrOverlap > 0.8) {
      novelty = Math.min(novelty, 0.05);
      fact_similarity_max = Math.max(fact_similarity_max, 0.95);
    }

    let maxEntityOverlap = 0.0;
    if (canonical.entityTokens.length > 0 && memory.actions.length > 0) {
      for (const act of memory.actions) {
        const prevEntities = SemanticCanonicalizer.extractArgumentBreakdown(act.tool, act.arguments).entities;
        for (const eNow of canonical.entityTokens) {
          if (prevEntities.some(p => p === eNow || eNow.includes(p) || p.includes(eNow))) {
            maxEntityOverlap = Math.max(maxEntityOverlap, 0.95);
          } else {
            for (const ePrev of prevEntities) {
              const vecA = MovenMrlEmbedder.embed(eNow, 64);
              const vecB = MovenMrlEmbedder.embed(ePrev, 64);
              const sim = MovenMrlEmbedder.cosineSimilarity(vecA, vecB, 64);
              if (sim > maxEntityOverlap) maxEntityOverlap = sim;
            }
          }
        }
      }
    }
    const entity_novelty = Math.max(0.0, 1.0 - maxEntityOverlap);

    // 5. Information Coverage
    const goal_coverage_before = coverage.before;

    let expected_goal_coverage_after = goal_coverage_before;
    if (coverage.totalRequired > 0) {
      let addsNewRequirement = false;
      const expectedLower = canonical.canonicalExpectedResult.toLowerCase();
      for (const req of memory.goalState.requiredItems) {
        if (!memory.goalState.satisfiedItems.has(req) && expectedLower.includes(req.toLowerCase())) {
          addsNewRequirement = true;
          break;
        }
      }
      if (addsNewRequirement) {
        expected_goal_coverage_after = Math.min(
          1.0,
          goal_coverage_before + 1.0 / coverage.totalRequired
        );
      }
    } else {
      expected_goal_coverage_after = novelty > 0.4
        ? Math.min(1.0, goal_coverage_before + 0.15)
        : goal_coverage_before;
    }

    // 6. State Progress & Relevance
    let state_change_estimate = 0.5;
    if (memory.stateSnapshots.length >= 2) {
      const sLast = memory.stateSnapshots[memory.stateSnapshots.length - 1];
      const sPrev = memory.stateSnapshots[memory.stateSnapshots.length - 2];
      state_change_estimate = Math.min(1.0, MovenMrlEmbedder.euclideanDistance(sLast, sPrev, targetDim));
    }
    const goal_relevance = hasGoal
      ? goal_similarity * (expected_goal_coverage_after >= goal_coverage_before ? 1.0 : 0.4)
      : 1.0;

    // 7. Historical Outcome Learning
    let historical_usefulness = 0.50;
    if (historicalStats && historicalStats.count > 0) {
      historical_usefulness = (historicalStats.useful + 1.0) / (historicalStats.count + 2.0);
    }

    // 8. Cost & Risk
    const tool_cost = input.cost ?? 0.0002;
    const normalized_cost = Math.min(1.0, tool_cost / Math.max(0.01, sessionBudgetDollar));

    let contradiction_signal = 0.0;
    const toolLower = input.tool.toLowerCase();
    if (toolLower.includes('delete') || toolLower.includes('remove')) {
      contradiction_signal = 0.35;
    }

    let risk_score = 0.0;
    if (policy) {
      if (policy.riskLevel === 'CRITICAL') risk_score = 0.90;
      else if (policy.riskLevel === 'HIGH') risk_score = 0.65;
      else if (policy.riskLevel === 'MEDIUM') risk_score = 0.35;
      else risk_score = 0.05;
    } else {
      if (toolLower.startsWith('delete') || toolLower.startsWith('drop') || toolLower.startsWith('execute_')) {
        risk_score = 0.85;
      } else if (toolLower.startsWith('update') || toolLower.startsWith('write') || toolLower.startsWith('send')) {
        risk_score = 0.50;
      } else {
        risk_score = 0.05;
      }
    }

    const features: SemanticFeatureVector = {
      goal_similarity: Number(goal_similarity.toFixed(4)),
      action_similarity_max: Number(action_similarity_max.toFixed(4)),
      action_similarity_mean: Number(action_similarity_mean.toFixed(4)),
      fact_similarity_max: Number(fact_similarity_max.toFixed(4)),
      fact_similarity_mean: Number(fact_similarity_mean.toFixed(4)),
      novelty: Number(novelty.toFixed(4)),
      entity_novelty: Number(entity_novelty.toFixed(4)),
      attribute_novelty: Number(attribute_novelty.toFixed(4)),
      goal_coverage_before: Number(goal_coverage_before.toFixed(4)),
      expected_goal_coverage_after: Number(expected_goal_coverage_after.toFixed(4)),
      state_change_estimate: Number(state_change_estimate.toFixed(4)),
      goal_relevance: Number(goal_relevance.toFixed(4)),
      zero_progress_streak: zeroProgressStreak,
      historical_usefulness: Number(historical_usefulness.toFixed(4)),
      tool_cost: Number(tool_cost.toFixed(6)),
      normalized_cost: Number(normalized_cost.toFixed(4)),
      contradiction_signal: Number(contradiction_signal.toFixed(4)),
      risk_score: Number(risk_score.toFixed(4)),
    };

    return { features, proposedActionVector, expectedResultVector };
  }
}
