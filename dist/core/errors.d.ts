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
export type MovenHeuristicType = 'repeat_tool_call' | 'cost_ceiling' | 'depth_ceiling' | 'no_progress_loop' | 'semantic_loop' | 'high_error_rate' | 'latency_hang' | 'schema_validation_failure' | 'token_burst_limit' | 'global_provider_backoff' | 'llm_judge_arbitrator' | 'ai_hallucination' | 'prompt_injection' | 'custom_rule';
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
