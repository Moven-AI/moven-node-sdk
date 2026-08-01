"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapLlamaIndexTools = wrapLlamaIndexTools;
const run_state_1 = require("../core/run-state");
const heuristics_1 = require("../core/heuristics");
const abort_1 = require("../kill/abort");
const reporter_1 = require("../reporter");
/**
 * Wraps LlamaIndex BaseTool / FunctionTool objects or arrays for Moven circuit breaker protection.
 * Intercepts tool .call() and .acall() executions, updates run-state, checks heuristics, and trips circuit breaker on limit violation.
 */
function wrapLlamaIndexTools(tools, options) {
    const optsWithFramework = { framework: 'LlamaIndex RAG Agent', ...options };
    const state = new run_state_1.MovenRunState(optsWithFramework);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    reporter.reportRunStart(state);
    if (Array.isArray(tools)) {
        return tools.map(t => wrapSingleLlamaIndexTool(t, state, reporter));
    }
    const wrappedObj = {};
    for (const [key, toolDef] of Object.entries(tools)) {
        wrappedObj[key] = wrapSingleLlamaIndexTool(toolDef, state, reporter);
    }
    return wrappedObj;
}
function wrapSingleLlamaIndexTool(toolDef, state, reporter) {
    if (!toolDef || typeof toolDef !== 'object')
        return toolDef;
    const toolName = toolDef.metadata?.name || toolDef.name || 'llamaindex_tool';
    const originalCall = toolDef.call || toolDef.acall || toolDef.fn;
    if (typeof originalCall !== 'function')
        return toolDef;
    const wrappedCall = async (input, ...rest) => {
        const log = state.recordToolCall(toolName, input);
        state.addCost(0.01);
        const check = heuristics_1.MovenHeuristicsEngine.evaluate(state);
        if (check.tripped) {
            await abort_1.MovenKillHandler.executeKill(check, state, reporter);
        }
        const start = Date.now();
        try {
            const res = await originalCall.call(toolDef, input, ...rest);
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
        call: wrappedCall,
        acall: wrappedCall,
    };
}
