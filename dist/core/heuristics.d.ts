import { MovenRunState } from './run-state';
import { MovenHeuristicType, MovenKillMetrics } from './errors';
export interface HeuristicTripResult {
    tripped: boolean;
    heuristic?: MovenHeuristicType;
    reason?: string;
    toolName?: string;
    toolArgs?: any;
    metrics?: MovenKillMetrics;
}
export declare class MovenHeuristicsEngine {
    static evaluate(state: MovenRunState): HeuristicTripResult;
    /**
     * Fast 200ms Cheap Model Judge Deduction via OpenRouter Public API
     * Analyzes recent execution history to determine if progress is being made
     */
    private static runCheapModelArbitrator;
}
