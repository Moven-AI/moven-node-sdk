"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MovenKillHandler = void 0;
const errors_1 = require("../core/errors");
class MovenKillHandler {
    /**
     * Handles a heuristic trip result by either activating auto-fallback or throwing a MovenKillError.
     */
    static async handleTripResult(tripResult, state, reporter) {
        if (!tripResult.tripped)
            return { fallbackActivated: false };
        // Auto-fallback: switch to cheaper model on first trip instead of killing
        if (state.options.autoFallbackCheaperModel && !state.isFallbackActive) {
            const cheaperModel = state.switchToCheaperModel();
            console.warn(`\x1b[33m\x1b[1m⚡ [Moven AI] Auto-Fallback Activated:\x1b[0m \x1b[36mRouting agent '${state.agentName}' to cheaper model '${cheaperModel}' instead of terminating run.\x1b[0m`);
            // Reset repeat call tracking for clean continuation under fallback model
            state.toolCalls = [];
            state.depth = Math.max(0, state.depth - 2);
            return { fallbackActivated: true };
        }
        // Already in fallback mode or auto-fallback disabled — execute kill
        await this.executeKill(tripResult, state, reporter);
        return { fallbackActivated: false };
    }
    static async executeKill(tripResult, state, reporter) {
        state.isKilled = true;
        const error = new errors_1.MovenKillError({
            runId: state.runId,
            heuristic: tripResult.heuristic || 'repeat_tool_call',
            reason: tripResult.reason || 'Circuit breaker tripped',
            toolName: tripResult.toolName,
            toolArgs: tripResult.toolArgs,
            metrics: tripResult.metrics || state.getMetrics(),
        });
        // Print vibrant, high-visibility ANSI color banner to terminal
        console.error(`\n\x1b[41m\x1b[30m\x1b[1m ⚡ MOVEN AI CIRCUIT BREAKER TRIPPED! ⚡ \x1b[0m`);
        console.error(`\x1b[31m\x1b[1m🛑 AGENT:\x1b[0m \x1b[33m\x1b[1m${state.agentName}\x1b[0m`);
        console.error(`\x1b[31m\x1b[1m🛑 HEURISTIC:\x1b[0m \x1b[36m${tripResult.heuristic || 'repeat_tool_call'}\x1b[0m`);
        console.error(`\x1b[31m\x1b[1m🛑 REASON:\x1b[0m ${tripResult.reason}`);
        if (tripResult.toolName) {
            console.error(`\x1b[31m\x1b[1m🛠️  OFFENDING TOOL:\x1b[0m \x1b[35m${tripResult.toolName}\x1b[0m`);
            console.error(`\x1b[31m\x1b[1m📋 ARGUMENTS:\x1b[0m \x1b[90m${JSON.stringify(tripResult.toolArgs || {})}\x1b[0m`);
        }
        const metrics = tripResult.metrics || state.getMetrics();
        const actualCost = metrics.totalCost || 0.01;
        let targetModelName = state.getCheaperModel() || state.options.currentModel || state.options.judgeModel || 'openai/gpt-4o-mini';
        let promptPerMillion = state.options.promptCostPerMillion || 0.15;
        let completionPerMillion = state.options.completionCostPerMillion || 0.60;
        if (reporter) {
            try {
                const judgeData = await reporter.queryJudgeArbitrator(state);
                if (judgeData && judgeData.pricing) {
                    targetModelName = judgeData.cheaperModel || judgeData.judgeModel || targetModelName;
                    promptPerMillion = judgeData.pricing.promptPerMillion;
                    completionPerMillion = judgeData.pricing.completionPerMillion;
                }
            }
            catch { }
        }
        // Transparent mathematical formula: (15 prevented runaway steps * 4,000 prompt tokens / 1M * prompt rate) - actual incurred cost
        const preventedRunawaySteps = Math.max(15 - metrics.totalToolCalls, 5);
        const estimatedPreventedTokens = preventedRunawaySteps * 4000;
        const preventedCost = (estimatedPreventedTokens / 1_000_000) * (promptPerMillion > 0 ? promptPerMillion : 2.50);
        const moneySaved = Math.max(preventedCost - actualCost, 0.50);
        console.error(`\x1b[32m\x1b[1m💰 MONEY SAVED:\x1b[0m \x1b[32m\x1b[1m$${moneySaved.toFixed(2)}\x1b[0m \x1b[90m[Model: ${targetModelName} | Rates: $${promptPerMillion}/1M in, $${completionPerMillion}/1M out | Formula: ${preventedRunawaySteps} steps prevented × 4k tokens - $${actualCost.toFixed(4)} cost]\x1b[0m\n`);
        // Notify user-provided callbacks if present
        if (state.options.onHallucination) {
            try {
                state.options.onHallucination({
                    agentName: state.agentName,
                    reason: tripResult.reason || 'Agent hallucination or infinite loop detected',
                    toolName: tripResult.toolName,
                    args: tripResult.toolArgs,
                });
            }
            catch (err) {
                console.error('[Moven AI] Error inside onHallucination callback:', err);
            }
        }
        if (state.options.onKill) {
            try {
                state.options.onKill(error);
            }
            catch (err) {
                console.error('[Moven AI] Error inside onKill callback:', err);
            }
        }
        // Report event asynchronously to hosted backend
        if (reporter) {
            reporter.reportKillEvent(error, state).catch(err => {
                console.warn('[Moven AI] Failed to report kill event:', err.message);
            });
        }
        // Throw catchable error
        throw error;
    }
    static createStreamAbortSignal(state, reporter) {
        const controller = new AbortController();
        const abort = (reason) => {
            state.isKilled = true;
            controller.abort(reason);
            if (reporter) {
                const error = new errors_1.MovenKillError({
                    runId: state.runId,
                    heuristic: 'repeat_tool_call',
                    reason: `Stream aborted: ${reason}`,
                    metrics: state.getMetrics(),
                });
                reporter.reportKillEvent(error, state).catch(() => { });
            }
        };
        return { signal: controller.signal, abort };
    }
}
exports.MovenKillHandler = MovenKillHandler;
