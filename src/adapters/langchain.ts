import { MovenRunState, MovenOptions } from '../core/run-state';
import { MovenHeuristicsEngine } from '../core/heuristics';
import { MovenKillHandler } from '../kill/abort';
import { MovenReporter } from '../reporter';

/**
 * Wraps LangChain / LangGraph tool objects or arrays for agent safety.
 * Intercepts tool .invoke() and ._call() executions, updates run state, checks heuristics, and trips circuit breaker on limit violation.
 */
export function wrapLangChainTools<T extends Record<string, any> | Array<any>>(
  tools: T,
  options?: MovenOptions
): T {
  const optsWithFramework = { framework: options?.framework || 'LangGraph', ...options };
  const state = new MovenRunState(optsWithFramework);
  const reporter = new MovenReporter(options?.apiKey, options?.endpoint);

  reporter.reportRunStart(state);

  if (Array.isArray(tools)) {
    return tools.map(t => wrapSingleLangChainTool(t, state, reporter)) as unknown as T;
  }

  const wrappedObj = {} as any;
  for (const [key, toolDef] of Object.entries(tools)) {
    wrappedObj[key] = wrapSingleLangChainTool(toolDef, state, reporter);
  }

  return wrappedObj as T;
}

function wrapSingleLangChainTool(toolDef: any, state: MovenRunState, reporter: MovenReporter) {
  if (!toolDef || typeof toolDef !== 'object') return toolDef;

  const toolName = toolDef.name || toolDef.id || 'langchain_tool';
  const originalInvoke = toolDef.invoke || toolDef.func || toolDef._call || toolDef.execute;

  if (typeof originalInvoke !== 'function') return toolDef;

  const wrappedInvoke = async (input: any, config?: any) => {
    const log = state.recordToolCall(toolName, input);

    state.addCost(0.01);

    const check = MovenHeuristicsEngine.evaluate(state);
    await MovenKillHandler.handleTripResult(check, state, reporter);

    const start = Date.now();
    try {
      const res = await originalInvoke.call(toolDef, input, config);
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

  if (toolDef.invoke) {
    return Object.assign(Object.create(Object.getPrototypeOf(toolDef)), toolDef, {
      invoke: wrappedInvoke,
    });
  }

  return {
    ...toolDef,
    execute: wrappedInvoke,
    func: wrappedInvoke,
    _call: wrappedInvoke,
  };
}
