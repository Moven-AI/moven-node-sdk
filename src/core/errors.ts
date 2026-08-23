export interface MovenKillMetrics {
  totalCost: number;
  totalToolCalls: number;
  repeatCallsCount: number;
  depth: number;
  durationMs: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  costPerPromptToken?: number;
  costPerCompletionToken?: number;
  moneySaved?: number;
  preventedTokens?: number;
}

export type MovenHeuristicType = 
  | 'repeat_tool_call'
  | 'cost_ceiling'
  | 'depth_ceiling'
  | 'no_progress_loop'
  | 'semantic_loop'          // Semantic Fingerprint Layer: caught via cosine similarity / entropy
  | 'high_error_rate'        // SRE Breaker: failure rate breached over sliding window
  | 'latency_hang'           // SRE Breaker: slow call rate / inference timeout breached
  | 'schema_validation_failure' // Structural JSON / output schema validation consecutive failures
  | 'token_burst_limit'      // Generation burst limit per step outside tool wrappers
  | 'global_provider_backoff' // Coordinated organization-wide provider degradation backoff
  | 'llm_judge_arbitrator'
  | 'ai_hallucination'
  | 'prompt_injection'
  | 'custom_rule';

export class MovenKillError extends Error {
  public readonly runId: string;
  public readonly heuristic: MovenHeuristicType;
  public readonly reason: string;
  public readonly toolName?: string;
  public readonly toolArgs?: any;
  public readonly metrics: MovenKillMetrics;

  constructor(params: {
    runId: string;
    heuristic: MovenHeuristicType;
    reason: string;
    toolName?: string;
    toolArgs?: any;
    metrics: MovenKillMetrics;
  }) {
    super(`[Moven AI Circuit Breaker Tripped] ${params.reason}`);
    this.name = 'MovenKillError';
    this.runId = params.runId;
    this.heuristic = params.heuristic;
    this.reason = params.reason;
    this.toolName = params.toolName;
    this.toolArgs = params.toolArgs;
    this.metrics = params.metrics;
    
    // Ensure proper prototype chain inheritance for custom errors in TS
    Object.setPrototypeOf(this, MovenKillError.prototype);
  }
}
