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
  | 'layer2_semantic_guard'  // Layer 2: Semantic Guard (In-Process Runtime Classifier)
  | 'layer2_block'
  | 'layer2_replan'
  | 'high_error_rate'        // SRE Breaker: failure rate breached over sliding window
  | 'latency_hang'           // SRE Breaker: slow call rate / inference timeout breached
  | 'schema_validation_failure' // Structural JSON / output schema validation consecutive failures
  | 'token_burst_limit'      // Generation burst limit per step outside tool wrappers
  | 'global_provider_backoff' // Coordinated organization-wide provider degradation backoff
  | 'ai_hallucination'
  | 'prompt_injection'
  | 'user_directed_ceiling'   // Human-attested repetition whose results stopped changing — waste backstop
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

/**
 * Thrown when `pauseOnTrip` is enabled and the circuit breaker wants to
 * PAUSE the agent for human review instead of killing it. Carries the
 * resumeToken so the operator/UI can resolve the halt via
 * MovenRewindEngine.resolve(state, 'resume' | 'replan' | 'discard').
 *
 * The run state is marked halted before this is thrown — the interception
 * guard blocks every subsequent tool call until an operator resumes.
 */
export class MovenPauseError extends Error {
  public readonly runId: string;
  public readonly reason: string;
  public readonly heuristic?: MovenHeuristicType;
  public readonly toolName?: string;
  public readonly toolArgs?: any;
  public readonly resumeToken: string;
  public readonly metrics: MovenKillMetrics;

  constructor(params: {
    runId: string;
    reason: string;
    heuristic?: MovenHeuristicType;
    toolName?: string;
    toolArgs?: any;
    resumeToken: string;
    metrics: MovenKillMetrics;
  }) {
    super(`[Moven AI Pause & Ask] ${params.reason}`);
    this.name = 'MovenPauseError';
    this.runId = params.runId;
    this.reason = params.reason;
    this.heuristic = params.heuristic;
    this.toolName = params.toolName;
    this.toolArgs = params.toolArgs;
    this.resumeToken = params.resumeToken;
    this.metrics = params.metrics;
    Object.setPrototypeOf(this, MovenPauseError.prototype);
  }
}
