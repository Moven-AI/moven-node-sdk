"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapCrewAITools = wrapCrewAITools;
const run_state_1 = require("../core/run-state");
const heuristics_1 = require("../core/heuristics");
const abort_1 = require("../kill/abort");
const reporter_1 = require("../reporter");
/**
 * Wraps CrewAI multi-agent tools for Moven circuit breaker protection.
 * Intercepts tool .run(), ._run(), or function execution, updates run-state, checks heuristics, and trips circuit breaker on limit violation.
 */
function wrapCrewAITools(tools, options) {
    const optsWithFramework = { framework: 'CrewAI Multi-Agent', ...options };
    const state = new run_state_1.MovenRunState(optsWithFramework);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    reporter.reportRunStart(state);
    if (Array.isArray(tools)) {
        return tools.map(t => wrapSingleCrewAITool(t, state, reporter));
    }
    const wrappedObj = {};
    for (const [key, toolDef] of Object.entries(tools)) {
        wrappedObj[key] = wrapSingleCrewAITool(toolDef, state, reporter);
    }
    return wrappedObj;
}
function wrapSingleCrewAITool(toolDef, state, reporter) {
    if (!toolDef || typeof toolDef !== 'object')
        return toolDef;
    const toolName = toolDef.name || toolDef.id || 'crewai_tool';
    const originalRun = toolDef.run || toolDef._run || toolDef.func || toolDef.execute;
    if (typeof originalRun !== 'function')
        return toolDef;
    const wrappedRun = async (input, ...rest) => {
        const log = state.recordToolCall(toolName, input);
        state.addCost(0.01);
        const check = heuristics_1.MovenHeuristicsEngine.evaluate(state);
        if (check.tripped) {
            await abort_1.MovenKillHandler.executeKill(check, state, reporter);
        }
        const start = Date.now();
        try {
            const res = await originalRun.call(toolDef, input, ...rest);
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
        run: wrappedRun,
        _run: wrappedRun,
        execute: wrappedRun,
    };
}
