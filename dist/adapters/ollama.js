"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapOllamaTools = wrapOllamaTools;
const run_state_1 = require("../core/run-state");
const heuristics_1 = require("../core/heuristics");
const abort_1 = require("../kill/abort");
const reporter_1 = require("../reporter");
/**
 * Wraps Ollama / Local LLM tool definitions for Moven circuit breaker protection.
 */
function wrapOllamaTools(tools, options) {
    const optsWithProvider = { provider: 'ollama', framework: 'Ollama Local LLM', ...options };
    const state = new run_state_1.MovenRunState(optsWithProvider);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    reporter.reportRunStart(state);
    const wrappedObj = {};
    for (const [toolName, toolDef] of Object.entries(tools)) {
        if (!toolDef)
            continue;
        const fn = typeof toolDef === 'function' ? toolDef : (toolDef.execute || toolDef.func || toolDef.run);
        if (typeof fn !== 'function') {
            wrappedObj[toolName] = toolDef;
            continue;
        }
        const wrappedFn = async (...args) => {
            const log = state.recordToolCall(toolName, args[0] || args);
            state.addCost(0.001); // Local inference cost estimation
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
            };
        }
    }
    return wrappedObj;
}
