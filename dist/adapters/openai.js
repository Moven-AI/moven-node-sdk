"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapOpenAIToolRunner = wrapOpenAIToolRunner;
const run_state_1 = require("../core/run-state");
const heuristics_1 = require("../core/heuristics");
const abort_1 = require("../kill/abort");
const reporter_1 = require("../reporter");
function wrapOpenAIToolRunner(toolName, fn, options, sharedState) {
    const optsWithProvider = { provider: 'openai', framework: options?.framework || 'OpenAI Assistants', ...options };
    const state = sharedState || new run_state_1.MovenRunState(optsWithProvider);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    const wrapped = async (...args) => {
        const log = state.recordToolCall(toolName, args[0]);
        // Check heuristics before execution
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
    return wrapped;
}
