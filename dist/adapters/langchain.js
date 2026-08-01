"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapLangChainTools = wrapLangChainTools;
const run_state_1 = require("../core/run-state");
const heuristics_1 = require("../core/heuristics");
const abort_1 = require("../kill/abort");
const reporter_1 = require("../reporter");
/**
 * Wraps LangChain / LangGraph tool objects or arrays for agent safety.
 * Intercepts tool .invoke() and ._call() executions, updates run state, checks heuristics, and trips circuit breaker on limit violation.
 */
function wrapLangChainTools(tools, options) {
    const state = new run_state_1.MovenRunState(options);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    reporter.reportRunStart(state);
    if (Array.isArray(tools)) {
        return tools.map(t => wrapSingleLangChainTool(t, state, reporter));
    }
    const wrappedObj = {};
    for (const [key, toolDef] of Object.entries(tools)) {
        wrappedObj[key] = wrapSingleLangChainTool(toolDef, state, reporter);
    }
    return wrappedObj;
}
function wrapSingleLangChainTool(toolDef, state, reporter) {
    if (!toolDef || typeof toolDef !== 'object')
        return toolDef;
    const toolName = toolDef.name || toolDef.id || 'langchain_tool';
    const originalInvoke = toolDef.invoke || toolDef.func || toolDef._call || toolDef.execute;
    if (typeof originalInvoke !== 'function')
        return toolDef;
    const wrappedInvoke = async (input, config) => {
        const log = state.recordToolCall(toolName, input);
        state.addCost(0.01);
        const check = heuristics_1.MovenHeuristicsEngine.evaluate(state);
        await abort_1.MovenKillHandler.handleTripResult(check, state, reporter);
        const start = Date.now();
        try {
            const res = await originalInvoke.call(toolDef, input, config);
            state.recordToolResult(log, res, Date.now() - start);
            const postCheck = heuristics_1.MovenHeuristicsEngine.evaluate(state);
            await abort_1.MovenKillHandler.handleTripResult(postCheck, state, reporter);
            return res;
        }
        catch (err) {
            if (err?.name === 'MovenKillError')
                throw err;
            state.recordToolResult(log, { error: err?.message || String(err) }, Date.now() - start);
            throw err;
        }
    };
    if (toolDef.invoke) {
        return Object.assign(Object.create(Object.getPrototypeOf(toolDef)), toolDef, {
            invoke: wrappedInvoke,
        });
    }
    return {
        ...toolDef,
        execute: wrappedInvoke,
        func: wrappedInvoke,
        _call: wrappedInvoke,
    };
}
