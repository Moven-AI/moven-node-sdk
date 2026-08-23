import { MovenRunState, MovenOptions } from '../core/run-state';
import { MovenHeuristicsEngine } from '../core/heuristics';
import { MovenKillHandler } from '../kill/abort';
import { MovenReporter } from '../reporter';

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

  if (!tools || typeof tools !== 'object') {
    return { tools: {} as T, state, reporter };
  }

  reporter.reportRunStart(state);

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

    const wrappedFn = async (args: any, context?: any) => {
      // 1. Record tool call in run state
      const log = state.recordToolCall(toolName, args);

      // Estimate token cost (mock/approx per tool step for cost ceiling check)
      const estimatedCost = (toolDef?.estimatedCost || 0.01);
      state.addCost(estimatedCost);

      // 2. Evaluate heuristics synchronous check
      const check = MovenHeuristicsEngine.evaluate(state);
      await MovenKillHandler.handleTripResult(check, state, reporter);

      // 3. Execute original tool
      const startTime = Date.now();
      try {
        const result = await originalExecute.call(toolDef, args, context);
        state.recordToolResult(log, result, Date.now() - startTime);

        // Re-check no-progress turn heuristic after result arrives
        const postCheck = MovenHeuristicsEngine.evaluate(state);
        await MovenKillHandler.handleTripResult(postCheck, state, reporter);

        return result;
      } catch (err: any) {
        if (err?.name === 'MovenKillError') throw err;
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

  return { tools: wrappedTools as T, state, reporter };
}

export function createMovenCircuitBreaker(options?: MovenOptions) {
  const state = new MovenRunState(options);
  const reporter = new MovenReporter(options?.apiKey, options?.endpoint);

  // Send initial agent config to backend on instantiation
  reporter.reportRunStart(state);

  return {
    state,
    reporter,
    getModel: () => state.activeModel,
    getActiveModel: () => state.activeModel,
    isFallback: () => state.isFallbackActive,
    updateSettings: async (newOptions: Partial<MovenOptions>) => {
      state.updateOptions(newOptions);
      await reporter.reportRunStart(state);
      return state.options;
    },
    syncWithCloud: async () => {
      await reporter.reportRunStart(state);
      return state.options;
    },
    wrapTools: <T extends Record<string, any>>(tools: T) => {
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
