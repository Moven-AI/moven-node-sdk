"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapToolsWithMoven = wrapToolsWithMoven;
exports.createMovenCircuitBreaker = createMovenCircuitBreaker;
const run_state_1 = require("../core/run-state");
const heuristics_1 = require("../core/heuristics");
const abort_1 = require("../kill/abort");
const reporter_1 = require("../reporter");
const rewind_1 = require("../core/rewind");
/**
 * Wraps tool definitions for Vercel AI SDK generateText/streamText.
 * Intercepts tool execution, updates run-state, checks heuristics, and trips circuit breaker on limit violation.
 */
function wrapToolsWithMoven(tools, options) {
    const optsWithFramework = { framework: options?.framework || 'Vercel AI SDK', ...options };
    const state = new run_state_1.MovenRunState(optsWithFramework);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    if (!tools || typeof tools !== 'object') {
        return { tools: {}, state, reporter };
    }
    reporter.reportRunStart(state);
    const wrappedTools = {};
    for (const [toolName, toolDef] of Object.entries(tools)) {
        if (!toolDef)
            continue;
        // Handle raw function tools or tool objects with .execute / .func / ._call
        const originalExecute = typeof toolDef === 'function'
            ? toolDef
            : (toolDef.execute || toolDef.func || toolDef._call);
        if (typeof originalExecute !== 'function') {
            wrappedTools[toolName] = toolDef;
            continue;
        }
        // Saga: register a per-tool compensating action if the toolDef carries one
        const inlineCompensation = (toolDef.compensate || (typeof toolDef === 'function' ? undefined : toolDef.moven?.compensate));
        if (inlineCompensation) {
            state.registerCompensation(toolName, inlineCompensation);
        }
        const wrappedFn = async (args, context) => {
            // 1. Record tool call in run state
            const log = state.recordToolCall(toolName, args);
            // Estimate token cost (mock/approx per tool step for cost ceiling check)
            const estimatedCost = (toolDef?.estimatedCost || 0.01);
            state.addCost(estimatedCost);
            // 2. Evaluate heuristics synchronous check
            const check = heuristics_1.MovenHeuristicsEngine.evaluate(state);
            await abort_1.MovenKillHandler.handleTripResult(check, state, reporter);
            // 3. Execute original tool
            const startTime = Date.now();
            try {
                const result = await originalExecute.call(toolDef, args, context);
                state.recordToolResult(log, result, Date.now() - startTime);
                // Re-check no-progress turn heuristic after result arrives
                const postCheck = heuristics_1.MovenHeuristicsEngine.evaluate(state);
                await abort_1.MovenKillHandler.handleTripResult(postCheck, state, reporter);
                return result;
            }
            catch (err) {
                if (err?.name === 'MovenKillError')
                    throw err;
                state.recordToolResult(log, { error: err?.message || String(err) }, Date.now() - startTime);
                throw err;
            }
        };
        if (typeof toolDef === 'function') {
            wrappedTools[toolName] = wrappedFn;
        }
        else {
            wrappedTools[toolName] = {
                ...toolDef,
                execute: wrappedFn,
            };
        }
    }
    return { tools: wrappedTools, state, reporter };
}
function createMovenCircuitBreaker(options) {
    const state = new run_state_1.MovenRunState(options);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    // Send initial agent config to backend on instantiation
    reporter.reportRunStart(state);
    return {
        state,
        reporter,
        getModel: () => state.activeModel,
        getActiveModel: () => state.activeModel,
        isFallback: () => state.isFallbackActive,
        isHalted: () => state.halted,
        /**
         * Honest rewind: restores in-process state, cancels uncommitted calls,
         * runs registered compensations, returns a receipt, halts + cooldowns.
         */
        rewind: async (opts) => rewind_1.MovenRewindEngine.rewind(state, reporter, opts),
        /** Operator decision on a halted run: 'resume' | 'replan' | 'discard' */
        resolveHalt: (decision, opts) => rewind_1.MovenRewindEngine.resolve(state, decision, opts),
        registerCompensation: (toolName, comp) => state.registerCompensation(toolName, comp),
        updateSettings: async (newOptions) => {
            state.updateOptions(newOptions);
            await reporter.reportRunStart(state);
            return state.options;
        },
        syncWithCloud: async () => {
            await reporter.reportRunStart(state);
            return state.options;
        },
        wrapTools: (tools) => {
            const res = wrapToolsWithMoven(tools, options);
            return {
                ...res.tools,
                tools: res.tools,
                state: res.state,
                reporter: res.reporter,
            };
        },
    };
}
