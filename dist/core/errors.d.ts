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
export type MovenHeuristicType = 'repeat_tool_call' | 'cost_ceiling' | 'depth_ceiling' | 'no_progress_loop' | 'semantic_loop' | 'layer2_semantic_guard' | 'layer2_block' | 'layer2_replan' | 'high_error_rate' | 'latency_hang' | 'schema_validation_failure' | 'token_burst_limit' | 'global_provider_backoff' | 'ai_hallucination' | 'prompt_injection' | 'user_directed_ceiling' | 'custom_rule';
export declare class MovenKillError extends Error {
    readonly runId: string;
    readonly heuristic: MovenHeuristicType;
    readonly reason: string;
    readonly toolName?: string;
    readonly toolArgs?: any;
    readonly metrics: MovenKillMetrics;
    constructor(params: {
        runId: string;
        heuristic: MovenHeuristicType;
        reason: string;
        toolName?: string;
        toolArgs?: any;
        metrics: MovenKillMetrics;
    });
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
export declare class MovenPauseError extends Error {
    readonly runId: string;
    readonly reason: string;
    readonly heuristic?: MovenHeuristicType;
    readonly toolName?: string;
    readonly toolArgs?: any;
    readonly resumeToken: string;
    readonly metrics: MovenKillMetrics;
    constructor(params: {
        runId: string;
        reason: string;
        heuristic?: MovenHeuristicType;
        toolName?: string;
        toolArgs?: any;
        resumeToken: string;
        metrics: MovenKillMetrics;
    });
}
