"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MovenKillHandler = void 0;
const errors_1 = require("../core/errors");
const pricing_1 = require("../core/pricing");
class MovenKillHandler {
    /**
     * Handles a heuristic trip result by checking dry-run mode, soft pause, auto-fallback, or throwing MovenKillError.
     */
    static async handleTripResult(tripResult, state, reporter) {
        if (!tripResult.tripped)
            return { fallbackActivated: false };
        // 1. Dry Run Simulation Mode Check
        if (state.options.dryRun) {
            console.warn(`\x1b[33m\x1b[1m🔍 [Moven AI - DRY RUN MODE]\x1b[0m \x1b[36mCircuit breaker simulated trip for heuristic '${tripResult.heuristic || 'repeat_tool_call'}': ${tripResult.reason}. Execution continues without interruption.\x1b[0m`);
            if (reporter) {
                reporter.sendPayload({
                    event: 'dry_run_trip',
                    runId: state.runId,
                    agentId: state.agentId,
                    agentName: state.agentName,
                    heuristic: tripResult.heuristic,
                    reason: tripResult.reason,
                    toolName: tripResult.toolName,
                    toolArgs: tripResult.toolArgs,
                    metrics: tripResult.metrics || state.getMetrics(),
                    timestamp: new Date().toISOString(),
                }).catch(() => { });
            }
            return { fallbackActivated: false, dryRunTrip: true };
        }
        // 2. Human-in-the-Loop Soft Trip / Pause & Ask Check
        if (state.options.pauseOnTrip) {
            const resumeToken = `resume_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            console.warn(`\x1b[33m\x1b[1m⏸️ [Moven AI - PAUSE & ASK]\x1b[0m \x1b[36mAgent '${state.agentName}' paused on suspicious activity for developer verification. Webhook dispatched. [Token: ${resumeToken}]\x1b[0m`);
            if (reporter) {
                reporter.sendPayload({
                    event: 'pause',
                    runId: state.runId,
                    agentId: state.agentId,
                    agentName: state.agentName,
                    heuristic: tripResult.heuristic,
                    reason: tripResult.reason,
                    toolName: tripResult.toolName,
                    toolArgs: tripResult.toolArgs,
                    resumeToken,
                    metrics: tripResult.metrics || state.getMetrics(),
                    timestamp: new Date().toISOString(),
                }).catch(() => { });
            }
            if (state.options.onPause) {
                try {
                    state.options.onPause({
                        agentName: state.agentName,
                        reason: tripResult.reason || 'Paused on suspicious loop',
                        toolName: tripResult.toolName,
                        args: tripResult.toolArgs,
                        resumeToken,
                    });
                }
                catch { }
            }
            return { fallbackActivated: false, paused: true };
        }
        // 3. Auto-fallback: switch to cheaper model on first trip instead of killing (NEVER bypass for security/prompt-injections)
        if (state.options.autoFallbackCheaperModel && !state.isFallbackActive && tripResult.heuristic !== 'prompt_injection') {
            const cheaperModel = state.switchToCheaperModel();
            console.warn(`\x1b[33m\x1b[1m⚡ [Moven AI] Auto-Fallback Activated:\x1b[0m \x1b[36mRouting agent '${state.agentName}' to cheaper model '${cheaperModel}' instead of terminating run.\x1b[0m`);
            // Report fallback event asynchronously to dashboard and webhooks
            if (reporter) {
                const killError = new errors_1.MovenKillError({
                    runId: state.runId,
                    heuristic: tripResult.heuristic || 'repeat_tool_call',
                    reason: `[Auto-Fallback to ${cheaperModel}] ${tripResult.reason || 'Circuit breaker tripped'}`,
                    toolName: tripResult.toolName,
                    toolArgs: tripResult.toolArgs,
                    metrics: tripResult.metrics || state.getMetrics(),
                });
                reporter.reportKillEvent(killError, state).catch(() => { });
            }
            if (state.options.onHallucination) {
                try {
                    state.options.onHallucination({
                        agentName: state.agentName,
                        reason: tripResult.reason || 'Agent loop detected (fallback activated)',
                        toolName: tripResult.toolName,
                        args: tripResult.toolArgs,
                    });
                }
                catch { }
            }
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
        const activeModel = state.options.currentModel || state.getCheaperModel() || 'openai/gpt-4o-mini';
        let customPromptRate = state.options.promptCostPerMillion;
        let customCompletionRate = state.options.completionCostPerMillion;
        if (reporter) {
            try {
                const judgeData = await reporter.queryJudgeArbitrator(state);
                if (judgeData && judgeData.pricing) {
                    customPromptRate = judgeData.pricing.promptPerMillion;
                    customCompletionRate = judgeData.pricing.completionPerMillion;
                }
            }
            catch { }
        }
        const calc = pricing_1.MovenDynamicPricingEngine.calculateMoneySaved({
            modelName: activeModel,
            totalToolCallsMade: metrics.totalToolCalls,
            actualCostSpent: metrics.totalCost,
            actualPromptTokensSpent: metrics.promptTokens ?? state.cumulativePromptTokens,
            actualCompletionTokensSpent: metrics.completionTokens ?? state.cumulativeCompletionTokens,
            customPromptRatePerMillion: customPromptRate,
            customCompletionRatePerMillion: customCompletionRate,
        });
        const moneySaved = calc.moneySaved;
        const promptPerMillion = calc.promptPerMillion;
        const completionPerMillion = calc.completionPerMillion;
        const totalPreventedTokens = calc.totalPreventedTokens;
        const preventedRunawaySteps = calc.preventedRunawaySteps;
        const actualCost = metrics.totalCost || 0;
        console.error(`\x1b[32m\x1b[1m💰 MONEY SAVED:\x1b[0m \x1b[32m\x1b[1m$${moneySaved >= 0.01 ? moneySaved.toFixed(2) : moneySaved.toFixed(4)}\x1b[0m \x1b[90m[Model: ${activeModel} | OpenRouter Live Rates: $${promptPerMillion}/1M in, $${completionPerMillion}/1M out | Math: ${preventedRunawaySteps} runaway turns prevented (${totalPreventedTokens.toLocaleString()} tokens prevented) - $${actualCost.toFixed(4)} spent]\x1b[0m\n`);
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
