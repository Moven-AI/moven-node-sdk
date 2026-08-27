/**
 * Moven Layer 2 — Semantic Guard Types (TypeScript SDK)
 */

export interface SemanticActionInput {
  tool: string;
  arguments?: Record<string, any>;
  goal?: string;
  expectedOutcome?: string;
  recentActions?: Array<{ tool: string; arguments?: Record<string, any>; timestamp?: number }>;
  recentResults?: Array<{ tool: string; result: any; timestamp?: number }>;
  knownFacts?: string[];
  cost?: number;
}

export interface CanonicalAction {
  rawTool: string;
  rawArgs: Record<string, any>;
  canonicalGoal: string;
  canonicalActionText: string;
  canonicalExpectedResult: string;
  entityTokens: string[];
  attributeTokens: string[];
  intentTokens: string[];
  hash: string;
}

export interface SemanticFeatureVector {
  goal_similarity: number;
  action_similarity_max: number;
  action_similarity_mean: number;
  fact_similarity_max: number;
  fact_similarity_mean: number;
  novelty: number;
  entity_novelty: number;
  attribute_novelty: number;
  goal_coverage_before: number;
  expected_goal_coverage_after: number;
  state_change_estimate: number;
  goal_relevance: number;
  zero_progress_streak: number;
  historical_usefulness: number;
  tool_cost: number;
  normalized_cost: number;
  contradiction_signal: number;
  risk_score: number;
}

export type DecisionType = 'ALLOW' | 'WARN' | 'REPLAN' | 'BLOCK';

export interface ModelHeadProbabilities {
  p_useful: number;
  p_redundant: number;
  p_goal_drift: number;
  p_low_novelty: number;
  p_risk: number;
  combined_score: number;
}

export interface Layer2DecisionResult {
  decision: DecisionType;
  probabilities: ModelHeadProbabilities;
  features: SemanticFeatureVector;
  reason: string;
  featureAttributions: Record<string, number>;
  latencyUs: number;
  cached: boolean;
  activeHysteresisState?: 'NORMAL' | 'INTERVENTION';
}

export interface ToolSemanticPolicy {
  toolName: string;
  category?: 'EXPLORATORY' | 'DATABASE' | 'COMMUNICATION' | 'MUTATING' | 'COMPUTATIONAL';
  noveltyWeight?: number;
  redundancyWeight?: number;
  driftWeight?: number;
  stateProgressWeight?: number;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface Layer2Options {
  /** Enable or disable Layer 2 Semantic Guard. Default: true */
  enabled?: boolean;
  /** Active preset profile */
  mode?: 'BALANCED' | 'EXPLORATORY' | 'MUTATING_STRICT' | 'AGGRESSIVE_COST_SAVER' | 'CUSTOM';
  /** Cosine / probability threshold to BLOCK on redundancy. Default: 0.97 */
  redundancyThreshold?: number;
  /** Probability threshold to REPLAN on goal drift. Default: 0.95 */
  driftThreshold?: number;
  /** Floor below which novelty is flagged as low. Default: 0.20 */
  noveltyThreshold?: number;
  /** Probability threshold to guarantee ALLOW on useful action. Default: 0.65 */
  usefulThreshold?: number;
  /** Enable hysteresis state machine to prevent oscillation. Default: true */
  hysteresisEnabled?: boolean;
  /** Hysteresis block trip threshold. Default: 0.95 */
  blockThreshold?: number;
  /** Hysteresis recovery threshold. Default: 0.70 */
  recoverThreshold?: number;
  /** Max actions held in bounded RAM hot path. Default: 32 */
  actionMemoryWindow?: number;
  /** Max facts held in bounded RAM hot path. Default: 128 */
  factMemoryWindow?: number;
  /** Enable Goal Graph & Information Coverage verification. Default: true */
  infoCoverageCheck?: boolean;
  /** Sync cold memory vectors to Pinecone/Vector DB. Default: true */
  pineconeSync?: boolean;
  /** Matryoshka dimension truncation (64, 128, 256). Default: 128 */
  mrlDimensions?: number;
  /** Custom vector DB host URL for open-source users */
  vectorDbHost?: string;
  /** Custom embedding API endpoint URL for open-source users */
  embeddingApiUrl?: string;
}
