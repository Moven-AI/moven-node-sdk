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
     * Async speculative evaluation for high-risk tool gating.
     *
     * Call this instead of evaluate() when the next tool call is high-risk
     * (declared in options.highRiskTools). The method runs all synchronous checks
     * first and, if none trip, fires the async LLM Judge in a background Promise.
     * Execution of the high-risk tool should be held until this resolves.
     *
     * @example
     *   if (state.isHighRiskTool(toolName)) {
     *     const result = await MovenHeuristicsEngine.evaluateAsync(state);
     *     if (result.tripped) throw new MovenKillError(...);
     *   }
     */
    static evaluateAsync(state: MovenRunState): Promise<HeuristicTripResult>;
    /**
     * Fast 200ms Cheap Model Judge Deduction via OpenRouter Public API
     * Analyzes recent execution history to determine if progress is being made
     */
    private static runCheapModelArbitrator;
    /**
     * Async LLM Judge for speculative execution gate.
     * Compresses context to last 3 reasoning steps + original goal and asks a binary question.
     * Uses the cheapest available model (Haiku / GPT-4o-mini / Gemini Flash Lite).
     */
    private static runAsyncJudge;
}
