import { MovenRunState, MovenOptions } from '../core/run-state';
import { MovenHeuristicsEngine } from '../core/heuristics';
import { MovenKillHandler } from '../kill/abort';
import { MovenReporter } from '../reporter';
import { MovenRewindEngine, RewindReceipt, RewindOptions } from '../core/rewind';
import { CompensationInput } from '../core/checkpoint';
import { recordToolCallSpan } from '../otel';
import { withMovenWarnings } from './model-warnings';

declare module '../core/run-state' {
  interface MovenOptions {
    /** toolDef-level compensating action picked up by wrapToolsWithMoven */
    compensate?: CompensationInput;
  }
}

/**
 * Extracts the most recent user message from an optional `messages` option
 * and opens the human-attestation window for it — ONLY for ongoing
 * conversations (messages.length > 1). A single-message setup is the initial
 * task prompt, which must NOT attest: Layer 2 and loop heuristics stay armed
 * for agent-initiated redundancy within that first turn. A NEW user message
 * in an ongoing conversation ("search tesla revenue again") is an explicit
 * human re-instruction.
 */
function attestedFromMessages(state: MovenRunState, options?: MovenOptions): void {
  const messages = (options as any)?.messages;
  if (!Array.isArray(messages) || messages.length <= 1) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') {
      const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content)
        ? m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join(' ')
        : '';
      if (content.trim()) state.recordUserInstruction(content);
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
export function wrapToolsWithState<T extends Record<string, any>>(
  tools: T,
  state: MovenRunState,
  reporter: MovenReporter,
  options?: MovenOptions
): T {
  if (!tools || typeof tools !== 'object') {
    return {} as T;
  }

  const wrappedTools = {} as any;

  for (const [toolName, toolDef] of Object.entries(tools)) {
    if (!toolDef) continue;

    // Handle raw function tools or tool objects with .execute / .func / ._call
    const originalExecute = typeof toolDef === 'function'
      ? toolDef
      : (toolDef.execute || toolDef.func || toolDef._call);

    if (typeof originalExecute !== 'function') {
      wrappedTools[toolName] = toolDef;
      continue;
    }

    // Saga: register a per-tool compensating action if the toolDef carries one
    const inlineCompensation = (toolDef.compensate || (typeof toolDef === 'function' ? undefined : toolDef.moven?.compensate)) as CompensationInput | undefined;
    if (inlineCompensation) {
      state.registerCompensation(toolName, inlineCompensation);
    }

    const wrappedFn = async (args: any, context?: any) => {
      // 1. Record tool call in run state (token/cost estimate is computed
      //    from real prompt sizes by the pricing engine inside recordToolCall)
      const log = state.recordToolCall(toolName, args);

      // 1b. Optional caller-declared per-call cost (opt-in, never fabricated)
      if (toolDef?.estimatedCost) {
        state.addCost(toolDef.estimatedCost);
      }

      // 2. Evaluate heuristics synchronous check
      const check = MovenHeuristicsEngine.evaluate(state);
      await MovenKillHandler.handleTripResult(check, state, reporter);

      // 3. Execute original tool
      const startTime = Date.now();
      try {
        const result = await originalExecute.call(toolDef, args, context);
        const latencyMs = Date.now() - startTime;
        state.recordToolResult(log, result, latencyMs);
        recordToolCallSpan({
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
        const postCheck = MovenHeuristicsEngine.evaluate(state);
        await MovenKillHandler.handleTripResult(postCheck, state, reporter);

        return result;
      } catch (err: any) {
        const isKill = err?.name === 'MovenKillError';
        const isPause = err?.name === 'MovenPauseError';
        recordToolCallSpan({
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
        if (isKill || isPause) throw err;
        state.recordToolResult(log, { error: err?.message || String(err) }, Date.now() - startTime);
        throw err;
      }
    };

    if (typeof toolDef === 'function') {
      wrappedTools[toolName] = wrappedFn;
    } else {
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
export function wrapToolsWithMoven<T extends Record<string, any>>(
  tools: T,
  options?: MovenOptions
): { tools: T; state: MovenRunState; reporter: MovenReporter } {
  const optsWithFramework = { framework: options?.framework || 'Vercel AI SDK', ...options };
  const state = new MovenRunState(optsWithFramework);
  const reporter = new MovenReporter(options?.apiKey, options?.endpoint);

  // Open the human-attestation window from the latest user message
  attestedFromMessages(state, optsWithFramework);

  reporter.reportRunStart(state);

  const wrappedTools = wrapToolsWithState(tools, state, reporter, optsWithFramework);

  return { tools: wrappedTools as T, state, reporter };
}

export function createMovenCircuitBreaker(options?: MovenOptions) {
  const state = new MovenRunState(options);
  const reporter = new MovenReporter(options?.apiKey, options?.endpoint);

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
    rewind: async (opts?: RewindOptions): Promise<RewindReceipt | null> =>
      MovenRewindEngine.rewind(state, reporter, opts),
    /** Operator decision on a halted run: 'resume' | 'replan' | 'discard' */
    resolveHalt: (decision: 'resume' | 'replan' | 'discard', opts?: { clearCooldown?: boolean }) =>
      MovenRewindEngine.resolve(state, decision, opts),
    registerCompensation: (toolName: string, comp: CompensationInput) => state.registerCompensation(toolName, comp),
    updateSettings: async (newOptions: Partial<MovenOptions>) => {
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
    wrapTools: <T extends Record<string, any>>(tools: T) => {
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
    warnModel: (messages: any[]) => withMovenWarnings(state, messages),
    /** Manually drain pending pre-trip warnings (custom prompt templating). */
    drainWarnings: () => state.drainWarnings(),
    /** Non-destructive peek at queued warnings (dashboards, tests, logging). */
    peekWarnings: () => state.peekWarnings(),
  };
}
