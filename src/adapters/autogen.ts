import { MovenRunState, MovenOptions } from '../core/run-state';
import { MovenHeuristicsEngine } from '../core/heuristics';
import { MovenKillHandler } from '../kill/abort';
import { MovenReporter } from '../reporter';

/**
 * Wraps AutoGen agent functions/tools for Moven circuit breaker protection.
 * Intercepts tool calls between AutoGen agents, updates run-state, checks heuristics, and trips circuit breaker on limit violation.
 */
export function wrapAutoGenTools<T extends Record<string, any> | Array<any>>(
  tools: T,
  options?: MovenOptions
): T {
  const optsWithFramework = { framework: 'AutoGen Multi-Agent', ...options };
  const state = new MovenRunState(optsWithFramework);
  const reporter = new MovenReporter(options?.apiKey, options?.endpoint);

  reporter.reportRunStart(state);

  if (Array.isArray(tools)) {
    return tools.map(t => wrapSingleAutoGenTool(t, state, reporter)) as unknown as T;
  }

  const wrappedObj = {} as any;
  for (const [key, toolDef] of Object.entries(tools)) {
    wrappedObj[key] = wrapSingleAutoGenTool(toolDef, state, reporter);
  }

  return wrappedObj as T;
}

function wrapSingleAutoGenTool(toolDef: any, state: MovenRunState, reporter: MovenReporter) {
  if (typeof toolDef === 'function') {
    const fnName = toolDef.name || 'autogen_function';
    return async (...args: any[]) => {
      const log = state.recordToolCall(fnName, args[0] || args);
      state.addCost(0.01);

      const check = MovenHeuristicsEngine.evaluate(state);
      await MovenKillHandler.handleTripResult(check, state, reporter);

      const start = Date.now();
      try {
        const res = await toolDef(...args);
        state.recordToolResult(log, res, Date.now() - start);

        const postCheck = MovenHeuristicsEngine.evaluate(state);
        await MovenKillHandler.handleTripResult(postCheck, state, reporter);

        return res;
      } catch (err: any) {
        if (err?.name === 'MovenKillError') throw err;
        state.recordToolResult(log, { error: err?.message || String(err) }, Date.now() - start);
        throw err;
      }
    };
  }

  if (!toolDef || typeof toolDef !== 'object') return toolDef;

  const toolName = toolDef.name || toolDef.id || 'autogen_tool';
  const originalFn = toolDef.execute || toolDef.func || toolDef.function;

  if (typeof originalFn !== 'function') return toolDef;

  const wrappedFn = async (...args: any[]) => {
    const log = state.recordToolCall(toolName, args[0] || args);
    state.addCost(0.01);

    const check = MovenHeuristicsEngine.evaluate(state);
    await MovenKillHandler.handleTripResult(check, state, reporter);

    const start = Date.now();
    try {
      const res = await originalFn.call(toolDef, ...args);
      state.recordToolResult(log, res, Date.now() - start);

      const postCheck = MovenHeuristicsEngine.evaluate(state);
      await MovenKillHandler.handleTripResult(postCheck, state, reporter);

      return res;
    } catch (err: any) {
      if (err?.name === 'MovenKillError') throw err;
      state.recordToolResult(log, { error: err?.message || String(err) }, Date.now() - start);
      throw err;
    }
  };

  return {
    ...toolDef,
    execute: wrappedFn,
    func: wrappedFn,
  };
}
