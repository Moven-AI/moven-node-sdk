import { HeuristicTripResult } from '../core/heuristics';
import { MovenRunState } from '../core/run-state';
import { MovenReporter } from '../reporter';
export declare class MovenKillHandler {
    /**
     * Handles a heuristic trip result by checking dry-run mode, soft pause, auto-fallback, or throwing MovenKillError.
     */
    static handleTripResult(tripResult: HeuristicTripResult, state: MovenRunState, reporter?: MovenReporter): Promise<{
        fallbackActivated: boolean;
        dryRunTrip?: boolean;
        paused?: boolean;
    }>;
    static executeKill(tripResult: HeuristicTripResult, state: MovenRunState, reporter?: MovenReporter): Promise<never>;
    static createStreamAbortSignal(state: MovenRunState, reporter?: MovenReporter): {
        signal: AbortSignal;
        abort: (reason: string) => void;
    };
}
