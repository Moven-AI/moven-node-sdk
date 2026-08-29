import { HeuristicTripResult } from '../core/heuristics';
import { MovenRunState } from '../core/run-state';
import { MovenReporter } from '../reporter';
export declare class MovenKillHandler {
    /**
     * Grace steps granted to a cheaper model after an auto-fallback switch.
     * Loop-detection heuristics are suppressed for this many tool calls while
     * hard limits (cost / depth / burn guard / firewall / SRE) stay active.
     */
    private static readonly FALLBACK_GRACE_STEPS;
    private static emitDecisionSpan;
    /**
     * Handles a heuristic trip result by checking dry-run mode, soft pause, auto-fallback, or throwing MovenKillError.
     */
    static handleTripResult(tripResult: HeuristicTripResult, state: MovenRunState, reporter?: MovenReporter): Promise<{
        fallbackActivated: boolean;
        dryRunTrip?: boolean;
        paused?: boolean;
    }>;
    static executeKill(tripResult: HeuristicTripResult, state: MovenRunState, reporter?: MovenReporter): Promise<never>;
    private static runKillSideEffects;
    static createStreamAbortSignal(state: MovenRunState, reporter?: MovenReporter): {
        signal: AbortSignal;
        abort: (reason: string) => void;
    };
}
