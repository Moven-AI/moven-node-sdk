"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapAutoGenTools = wrapAutoGenTools;
const run_state_1 = require("../core/run-state");
const heuristics_1 = require("../core/heuristics");
const abort_1 = require("../kill/abort");
const reporter_1 = require("../reporter");
/**
 * Wraps AutoGen agent functions/tools for Moven circuit breaker protection.
 * Intercepts tool calls between AutoGen agents, updates run-state, checks heuristics, and trips circuit breaker on limit violation.
 */
function wrapAutoGenTools(tools, options) {
    const optsWithFramework = { framework: 'AutoGen Multi-Agent', ...options };
    const state = new run_state_1.MovenRunState(optsWithFramework);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    reporter.reportRunStart(state);
    if (Array.isArray(tools)) {
        return tools.map(t => wrapSingleAutoGenTool(t, state, reporter));
    }
    const wrappedObj = {};
    for (const [key, toolDef] of Object.entries(tools)) {
        wrappedObj[key] = wrapSingleAutoGenTool(toolDef, state, reporter);
    }
    return wrappedObj;
}
function wrapSingleAutoGenTool(toolDef, state, reporter) {
    if (typeof toolDef === 'function') {
        const fnName = toolDef.name || 'autogen_function';
        return async (...args) => {
            const log = state.recordToolCall(fnName, args[0] || args);
            state.addCost(0.01);
            const check = heuristics_1.MovenHeuristicsEngine.evaluate(state);
            if (check.tripped) {
                await abort_1.MovenKillHandler.executeKill(check, state, reporter);
            }
            const start = Date.now();
            try {
                const res = await toolDef(...args);
                state.recordToolResult(log, res, Date.now() - start);
                const postCheck = heuristics_1.MovenHeuristicsEngine.evaluate(state);
                if (postCheck.tripped) {
                    await abort_1.MovenKillHandler.executeKill(postCheck, state, reporter);
                }
                return res;
            }
            catch (err) {
                if (err?.name === 'MovenKillError')
                    throw err;
                state.recordToolResult(log, { error: err?.message || String(err) }, Date.now() - start);
                throw err;
            }
        };
    }
    if (!toolDef || typeof toolDef !== 'object')
        return toolDef;
    const toolName = toolDef.name || toolDef.id || 'autogen_tool';
    const originalFn = toolDef.execute || toolDef.func || toolDef.function;
    if (typeof originalFn !== 'function')
        return toolDef;
    const wrappedFn = async (...args) => {
        const log = state.recordToolCall(toolName, args[0] || args);
        state.addCost(0.01);
        const check = heuristics_1.MovenHeuristicsEngine.evaluate(state);
        if (check.tripped) {
            await abort_1.MovenKillHandler.executeKill(check, state, reporter);
        }
        const start = Date.now();
        try {
            const res = await originalFn.call(toolDef, ...args);
            state.recordToolResult(log, res, Date.now() - start);
            const postCheck = heuristics_1.MovenHeuristicsEngine.evaluate(state);
            if (postCheck.tripped) {
                await abort_1.MovenKillHandler.executeKill(postCheck, state, reporter);
            }
            return res;
        }
        catch (err) {
            if (err?.name === 'MovenKillError')
                throw err;
            state.recordToolResult(log, { error: err?.message || String(err) }, Date.now() - start);
            throw err;
        }
    };
    return {
        ...toolDef,
        execute: wrappedFn,
        func: wrappedFn,
    };
}
