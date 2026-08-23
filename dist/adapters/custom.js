"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapCustomTool = wrapCustomTool;
exports.wrapCustomToolRegistry = wrapCustomToolRegistry;
exports.movenGuard = movenGuard;
const run_state_1 = require("../core/run-state");
const heuristics_1 = require("../core/heuristics");
const abort_1 = require("../kill/abort");
const reporter_1 = require("../reporter");
/**
 * Universal Wrapper for Custom AI Agents & Custom SDKs
 * Wraps any arbitrary function or tool execution with Moven AI Circuit Breaker.
 *
 * @param toolName Name of the tool or action being executed
 * @param fn Custom tool execution function
 * @param options Moven circuit breaker options
 * @param sharedState Optional shared MovenRunState for multi-tool or multi-step execution sessions
 */
function wrapCustomTool(toolName, fn, options, sharedState) {
    const optsWithProvider = { provider: 'custom-sdk', ...options };
    const state = sharedState || new run_state_1.MovenRunState(optsWithProvider);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    const wrapped = async (...args) => {
        const log = state.recordToolCall(toolName, args[0]);
        // Check heuristics before execution
        const preCheck = heuristics_1.MovenHeuristicsEngine.evaluate(state);
        await abort_1.MovenKillHandler.handleTripResult(preCheck, state, reporter);
        const start = Date.now();
        try {
            const result = await fn(...args);
            state.recordToolResult(log, result, Date.now() - start);
            const postCheck = heuristics_1.MovenHeuristicsEngine.evaluate(state);
            await abort_1.MovenKillHandler.handleTripResult(postCheck, state, reporter);
            return result;
        }
        catch (err) {
            if (err?.name === 'MovenKillError')
                throw err;
            throw err;
        }
    };
    return wrapped;
}
/**
 * Universal Wrapper for Custom Class/Object SDK Tool Registries
 * Accepts an object map of custom tools or functions and wraps every tool function automatically.
 */
function wrapCustomToolRegistry(tools, options) {
    const state = new run_state_1.MovenRunState({ provider: 'custom-sdk', ...options });
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
