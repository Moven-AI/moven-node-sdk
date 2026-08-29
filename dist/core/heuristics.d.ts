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
}
