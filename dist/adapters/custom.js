"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapCustomTool = wrapCustomTool;
exports.wrapCustomToolRegistry = wrapCustomToolRegistry;
exports.movenGuard = movenGuard;
const run_state_1 = require("../core/run-state");
const heuristics_1 = require("../core/heuristics");
const abort_1 = require("../kill/abort");
const reporter_1 = require("../reporter");
const rewind_1 = require("../core/rewind");
const otel_1 = require("../otel");
/**
 * Universal Wrapper for Custom AI Agents & Custom SDKs
 * Wraps any arbitrary function or tool execution with Moven AI Circuit Breaker.
 *
 * The wrapped function exposes a `moven` handle (state / reporter / rewind /
 * resolveHalt) so custom-SDK integrations get the same Ctrl+Z rewind
 * capability as the Vercel AI SDK adapter.
 *
 * @param toolName Name of the tool or action being executed
 * @param fn Custom tool execution function
 * @param options Moven circuit breaker options
 * @param sharedState Optional shared MovenRunState for multi-tool or multi-step execution sessions
 */
function wrapCustomTool(toolName, fn, options, sharedState) {
    const optsWithProvider = { provider: options?.provider || 'custom-sdk', ...options };
    const state = sharedState || new run_state_1.MovenRunState(optsWithProvider);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    // Saga: register the inline compensating action (inverse) for this tool
    if (options?.compensate) {
        state.registerCompensation(toolName, options.compensate);
    }
    const wrapped = async (...args) => {
        const log = state.recordToolCall(toolName, args[0]);
        const start = Date.now();
        try {
            // Check heuristics before execution
            const preCheck = heuristics_1.MovenHeuristicsEngine.evaluate(state);
            await abort_1.MovenKillHandler.handleTripResult(preCheck, state, reporter);
            const result = await fn(...args);
            const latencyMs = Date.now() - start;
            state.recordToolResult(log, result, latencyMs);
            (0, otel_1.recordToolCallSpan)({
                toolName,
                runId: state.runId,
                agentId: state.agentId,
                agentName: state.agentName,
                decision: 'ALLOW',
                cost: log.cost,
                latencyMs,
                startedAt: start,
                durationMs: latencyMs,
            });
            const postCheck = heuristics_1.MovenHeuristicsEngine.evaluate(state);
            await abort_1.MovenKillHandler.handleTripResult(postCheck, state, reporter);
            return result;
        }
        catch (err) {
            const latencyMs = Date.now() - start;
            const isKill = err?.name === 'MovenKillError';
            const isPause = err?.name === 'MovenPauseError';
            (0, otel_1.recordToolCallSpan)({
                toolName,
                runId: state.runId,
                agentId: state.agentId,
                agentName: state.agentName,
                decision: isKill ? 'KILL' : isPause ? 'PAUSE' : 'WARN',
                cost: log.cost,
                latencyMs,
                error: !isPause,
                reason: isKill || isPause ? err?.reason : err?.message,
                startedAt: start,
                durationMs: latencyMs,
            });
            if (isKill) {
                void otel_1.MovenOtelExporter.flush();
                // Opt-in auto-rewind: run the honest rewind (saga compensations +
                // halt + cooldown + receipt) before surfacing the kill error.
                if (state.options.autoRewindOnKill && !err.__movenRewound) {
                    try {
                        err.__movenRewound = true;
                        const receipt = await rewind_1.MovenRewindEngine.rewind(state, reporter, {
                            triggeredBy: 'auto',
                            offendingTool: err.toolName || toolName,
                        });
                        err.rewindReceipt = receipt;
                    }
                    catch {
                        // Never mask the kill error with a rewind failure
                    }
                }
                throw err;
            }
            if (isPause)
                throw err;
            // Record the failure so the call doesn't stay in_flight forever — the
            // rewind receipt then reflects it honestly (reached the downstream API).
            state.recordToolResult(log, { error: err?.message || String(err) }, Date.now() - start);
            throw err;
        }
    };
    // Expose the run controls on the wrapped function so custom integrations
    // can drive the Ctrl+Z rewind / halt resolution without the Vercel adapter.
    wrapped.moven = {
        state,
        reporter,
        rewind: async (opts) => rewind_1.MovenRewindEngine.rewind(state, reporter, opts),
        resolveHalt: (decision, opts) => rewind_1.MovenRewindEngine.resolve(state, decision, opts),
        registerCompensation: (name, comp) => state.registerCompensation(name, comp),
    };
    return wrapped;
}
/**
 * Universal Wrapper for Custom Class/Object SDK Tool Registries
 * Accepts an object map of custom tools or functions and wraps every tool function automatically.
 */
function wrapCustomToolRegistry(tools, options) {
    const state = new run_state_1.MovenRunState({ provider: options?.provider || 'custom-sdk', ...options });
    const wrapped = {};
    for (const [name, fn] of Object.entries(tools)) {
        if (typeof fn === 'function') {
            wrapped[name] = wrapCustomTool(name, fn, options, state);
        }
        else {
            wrapped[name] = fn;
        }
    }
    return wrapped;
}
/**
 * Developer-Friendly Universal Function Wrapper
 * Can be called as `movenGuard(fn, options)` or `movenGuard('tool_name', fn, options)`
 *
 * NOTE: each top-level movenGuard() call gets its own MovenRunState (and its
 * own cost budget) unless you pass a shared state via init:
 *   moven.init({...}); moven.guard(fn)  → all moven.guard()ed fns share one state.
 * For manual sharing use wrapCustomTool(name, fn, opts, sharedState).
 */
function movenGuard(nameOrFn, fnOrOptions, options) {
    if (typeof nameOrFn === 'function') {
        const fn = nameOrFn;
        const opts = fnOrOptions || {};
        const inferredName = fn.name || 'custom_tool';
        return wrapCustomTool(inferredName, fn, opts);
    }
    else {
        const name = nameOrFn;
        const fn = fnOrOptions;
        return wrapCustomTool(name, fn, options);
    }
}
