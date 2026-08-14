export interface MovenKillMetrics {
    totalCost: number;
    totalToolCalls: number;
    repeatCallsCount: number;
    depth: number;
    durationMs: number;
}
export type MovenHeuristicType = 'repeat_tool_call' | 'cost_ceiling' | 'depth_ceiling' | 'no_progress_loop' | 'semantic_loop' | 'llm_judge_arbitrator' | 'ai_hallucination' | 'custom_rule';
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
