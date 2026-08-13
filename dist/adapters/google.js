"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapGoogleGeminiTools = wrapGoogleGeminiTools;
const run_state_1 = require("../core/run-state");
const heuristics_1 = require("../core/heuristics");
const abort_1 = require("../kill/abort");
const reporter_1 = require("../reporter");
/**
 * Wraps Google Gemini SDK FunctionDeclarations and function handlers for Moven circuit breaker protection.
 */
function wrapGoogleGeminiTools(tools, options) {
    const optsWithProvider = { provider: 'google', framework: 'Google Gemini SDK', ...options };
    const state = new run_state_1.MovenRunState(optsWithProvider);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    reporter.reportRunStart(state);
    const wrappedObj = {};
    for (const [toolName, toolDef] of Object.entries(tools)) {
        if (!toolDef)
            continue;
        const fn = typeof toolDef === 'function' ? toolDef : (toolDef.execute || toolDef.handler || toolDef.function);
        if (typeof fn !== 'function') {
            wrappedObj[toolName] = toolDef;
            continue;
        }
        const wrappedFn = async (...args) => {
            const log = state.recordToolCall(toolName, args[0] || args);
            state.addCost(0.0075);
            const check = heuristics_1.MovenHeuristicsEngine.evaluate(state);
            await abort_1.MovenKillHandler.handleTripResult(check, state, reporter);
            const start = Date.now();
            try {
                const res = await fn(...args);
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
        if (typeof toolDef === 'function') {
            wrappedObj[toolName] = wrappedFn;
        }
        else {
            wrappedObj[toolName] = {
                ...toolDef,
                execute: wrappedFn,
                handler: wrappedFn,
            };
        }
    }
    return wrappedObj;
}
