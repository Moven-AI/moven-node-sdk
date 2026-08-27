import { SemanticFeatureVector, ModelHeadProbabilities } from './types';

export class TinySemanticClassifier {
  private static sigmoid(z: number): number {
    if (z > 15) return 1.0;
    if (z < -15) return 0.0;
    return 1.0 / (1.0 + Math.exp(-z));
  }

  private static readonly WEIGHTS_USEFUL = [
    4.0, -2.2, -1.5, -3.5, -1.8, 1.2, 0.8, 0.8, -2.5, 2.0, 1.5, 3.5, -2.0, 2.1, -0.5, -0.8, -2.5, -1.0,
  ];
  private static readonly BIAS_USEFUL = -1.2;

  private static readonly WEIGHTS_REDUNDANT = [
    -0.5, 3.8, 2.4, 4.5, 2.8, -3.6, -2.8, -3.2, 2.2, -2.5, -1.5, -1.0, 2.2, -2.4, 0.4, 0.5, 0.8, 0.5,
  ];
  private static readonly BIAS_REDUNDANT = -2.8;

  private static readonly WEIGHTS_DRIFT = [
    -10.0, 0.5, 0.2, -0.5, -0.5, 1.2, 1.0, 0.8, 0.5, -3.0, -0.5, -7.0, 2.5, -1.8, 0.8, 1.0, 2.2, 0.5,
  ];
  private static readonly BIAS_DRIFT = 2.2;

  private static readonly WEIGHTS_NOVELTY = [
    0.0, 3.2, 2.0, 3.5, 2.2, -4.5, -3.8, -3.5, 1.5, -1.8, -1.2, -0.5, 1.8, -1.2, 0.2, 0.2, 0.5, 0.2,
  ];
  private static readonly BIAS_NOVELTY = -1.5;

  private static readonly WEIGHTS_RISK = [
    -0.5, 0.2, 0.1, 0.2, 0.1, 0.5, 0.2, 0.2, 0.2, 0.2, 1.2, -0.8, 1.0, -1.0, 3.2, 3.8, 4.2, 6.0,
  ];
  private static readonly BIAS_RISK = -3.5;

  private static toArray(f: SemanticFeatureVector): number[] {
    return [
      f.goal_similarity,
      f.action_similarity_max,
      f.action_similarity_mean,
      f.fact_similarity_max,
      f.fact_similarity_mean,
      f.novelty,
      f.entity_novelty,
      f.attribute_novelty,
      f.goal_coverage_before,
      f.expected_goal_coverage_after,
      f.state_change_estimate,
      f.goal_relevance,
      f.zero_progress_streak,
      f.historical_usefulness,
      f.tool_cost,
      f.normalized_cost,
      f.contradiction_signal,
      f.risk_score,
    ];
  }

  public static predict(features: SemanticFeatureVector): {
    probabilities: ModelHeadProbabilities;
    attributions: Record<string, number>;
  } {
    const x = this.toArray(features);
    const featureNames = [
      'goal_similarity', 'action_similarity_max', 'action_similarity_mean',
      'fact_similarity_max', 'fact_similarity_mean', 'novelty', 'entity_novelty',
      'attribute_novelty', 'goal_coverage_before', 'expected_goal_coverage_after',
      'state_change_estimate', 'goal_relevance', 'zero_progress_streak',
      'historical_usefulness', 'tool_cost', 'normalized_cost',
      'contradiction_signal', 'risk_score'
    ];

    let zUseful = this.BIAS_USEFUL;
    let zRedundant = this.BIAS_REDUNDANT;
    let zDrift = this.BIAS_DRIFT;
    let zNovelty = this.BIAS_NOVELTY;
    let zRisk = this.BIAS_RISK;

    const attributions: Record<string, number> = {};

    for (let i = 0; i < x.length; i++) {
      const val = x[i];
      zUseful += this.WEIGHTS_USEFUL[i] * val;
      zRedundant += this.WEIGHTS_REDUNDANT[i] * val;
      zDrift += this.WEIGHTS_DRIFT[i] * val;
      zNovelty += this.WEIGHTS_NOVELTY[i] * val;
      zRisk += this.WEIGHTS_RISK[i] * val;

      const netWeight = this.WEIGHTS_USEFUL[i] - this.WEIGHTS_REDUNDANT[i] - this.WEIGHTS_DRIFT[i];
      attributions[featureNames[i]] = Number((netWeight * val).toFixed(4));
    }

    const p_useful = Number(this.sigmoid(zUseful).toFixed(4));
    const p_redundant = Number(this.sigmoid(zRedundant).toFixed(4));
    const p_goal_drift = Number(this.sigmoid(zDrift).toFixed(4));
    const p_low_novelty = Number(this.sigmoid(zNovelty).toFixed(4));
    const p_risk = Number(this.sigmoid(zRisk).toFixed(4));
    const combined_score = Number(Math.max(-1.0, Math.min(1.0, p_useful - p_redundant - p_goal_drift)).toFixed(4));

    return {
      probabilities: {
        p_useful,
        p_redundant,
        p_goal_drift,
        p_low_novelty,
        p_risk,
        combined_score,
      },
      attributions,
    };
  }
}
