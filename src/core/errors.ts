export interface MovenKillMetrics {
  totalCost: number;
  totalToolCalls: number;
  repeatCallsCount: number;
  depth: number;
  durationMs: number;
}

export type MovenHeuristicType = 
  | 'repeat_tool_call'
  | 'cost_ceiling'
  | 'depth_ceiling'
  | 'no_progress_loop'
  | 'llm_judge_arbitrator'
  | 'ai_hallucination'
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
