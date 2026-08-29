"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapToolsWithState = wrapToolsWithState;
exports.wrapToolsWithMoven = wrapToolsWithMoven;
exports.createMovenCircuitBreaker = createMovenCircuitBreaker;
const run_state_1 = require("../core/run-state");
const heuristics_1 = require("../core/heuristics");
const abort_1 = require("../kill/abort");
const reporter_1 = require("../reporter");
const rewind_1 = require("../core/rewind");
const otel_1 = require("../otel");
const model_warnings_1 = require("./model-warnings");
/**
 * Extracts the most recent user message from an optional `messages` option
 * and opens the human-attestation window for it — ONLY for ongoing
 * conversations (messages.length > 1). A single-message setup is the initial
 * task prompt, which must NOT attest: Layer 2 and loop heuristics stay armed
 * for agent-initiated redundancy within that first turn. A NEW user message
 * in an ongoing conversation ("search tesla revenue again") is an explicit
 * human re-instruction.
 */
function attestedFromMessages(state, options) {
    const messages = options?.messages;
    if (!Array.isArray(messages) || messages.length <= 1)
        return;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role === 'user') {
            const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content)
                ? m.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ')
                : '';
            if (content.trim())
                state.recordUserInstruction(content);
            return;
        }
    }
}
/**
 * Core wrapping logic — wraps tool definitions against a GIVEN run state so
 * every entry point (wrapToolsWithMoven, createMovenCircuitBreaker, the
 * LangGraph guard) shares one state. This is what keeps breaker.rewind()
 * operating on the SAME ledger the wrapped tools write to.
 */
function wrapToolsWithState(tools, state, reporter, options) {
    if (!tools || typeof tools !== 'object') {
        return {};
    }
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
            // 1. Record tool call in run state (token/cost estimate is computed
            //    from real prompt sizes by the pricing engine inside recordToolCall)
            const log = state.recordToolCall(toolName, args);
            // 1b. Optional caller-declared per-call cost (opt-in, never fabricated)
            if (toolDef?.estimatedCost) {
                state.addCost(toolDef.estimatedCost);
            }
            // 2. Evaluate heuristics synchronous check
            const check = heuristics_1.MovenHeuristicsEngine.evaluate(state);
            await abort_1.MovenKillHandler.handleTripResult(check, state, reporter);
            // 3. Execute original tool
            const startTime = Date.now();
            try {
                const result = await originalExecute.call(toolDef, args, context);
                const latencyMs = Date.now() - startTime;
                state.recordToolResult(log, result, latencyMs);
                (0, otel_1.recordToolCallSpan)({
                    toolName,
                    runId: state.runId,
                    agentId: state.agentId,
                    agentName: state.agentName,
                    decision: 'ALLOW',
                    cost: log.cost,
                    latencyMs,
                    startedAt: startTime,
                    durationMs: latencyMs,
                });
                // Re-check no-progress turn heuristic after result arrives
                const postCheck = heuristics_1.MovenHeuristicsEngine.evaluate(state);
                await abort_1.MovenKillHandler.handleTripResult(postCheck, state, reporter);
                return result;
            }
            catch (err) {
                const isKill = err?.name === 'MovenKillError';
                const isPause = err?.name === 'MovenPauseError';
                (0, otel_1.recordToolCallSpan)({
                    toolName,
                    runId: state.runId,
                    agentId: state.agentId,
                    agentName: state.agentName,
                    decision: isKill ? 'KILL' : isPause ? 'PAUSE' : 'WARN',
                    cost: log.cost,
                    latencyMs: Date.now() - startTime,
                    error: !isPause,
                    reason: isKill || isPause ? err?.reason : err?.message,
                    startedAt: startTime,
                    durationMs: Date.now() - startTime,
                });
                if (isKill || isPause)
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
    return wrappedTools;
}
/**
 * Wraps tool definitions for Vercel AI SDK generateText/streamText.
 * Intercepts tool execution, updates run-state, checks heuristics, and trips circuit breaker on limit violation.
 */
function wrapToolsWithMoven(tools, options) {
    const optsWithFramework = { framework: options?.framework || 'Vercel AI SDK', ...options };
    const state = new run_state_1.MovenRunState(optsWithFramework);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    // Open the human-attestation window from the latest user message
    attestedFromMessages(state, optsWithFramework);
    reporter.reportRunStart(state);
    const wrappedTools = wrapToolsWithState(tools, state, reporter, optsWithFramework);
    return { tools: wrappedTools, state, reporter };
}
function createMovenCircuitBreaker(options) {
    const state = new run_state_1.MovenRunState(options);
    const reporter = new reporter_1.MovenReporter(options?.apiKey, options?.endpoint);
    // Open the human-attestation window from the latest user message
    attestedFromMessages(state, options);
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
        /**
         * Wraps tools against THIS breaker's run state — the same state that
         * rewind()/resolveHalt() operate on, so Ctrl+Z always rewinds the
         * ledger the tools actually wrote to.
         */
        wrapTools: (tools) => {
            const wrapped = wrapToolsWithState(tools, state, reporter, options);
            return {
                ...wrapped,
                tools: wrapped,
                state,
                reporter,
            };
        },
        /**
         * FRAMEWORK-AGNOSTIC WARNING FLOW — works with any SDK (OpenAI, Anthropic,
         * CrewAI, AutoGen, LlamaIndex, raw fetch loops). Call this on your messages
         * array right before EVERY model invocation; pending pre-trip warnings are
         * appended as a final `{ role: 'system', content }` message and drained.
         * Pure — the input array is never mutated.
         */
        warnModel: (messages) => (0, model_warnings_1.withMovenWarnings)(state, messages),
        /** Manually drain pending pre-trip warnings (custom prompt templating). */
        drainWarnings: () => state.drainWarnings(),
        /** Non-destructive peek at queued warnings (dashboards, tests, logging). */
        peekWarnings: () => state.peekWarnings(),
    };
}
