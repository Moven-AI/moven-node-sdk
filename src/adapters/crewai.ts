import { MovenRunState, MovenOptions } from '../core/run-state';
import { MovenHeuristicsEngine } from '../core/heuristics';
import { MovenKillHandler } from '../kill/abort';
import { MovenReporter } from '../reporter';

/**
 * Wraps CrewAI multi-agent tools for Moven circuit breaker protection.
 * Intercepts tool .run(), ._run(), or function execution, updates run-state, checks heuristics, and trips circuit breaker on limit violation.
 */
export function wrapCrewAITools<T extends Record<string, any> | Array<any>>(
  tools: T,
  options?: MovenOptions
): T {
  const optsWithFramework = { framework: 'CrewAI Multi-Agent', ...options };
  const state = new MovenRunState(optsWithFramework);
  const reporter = new MovenReporter(options?.apiKey, options?.endpoint);

  reporter.reportRunStart(state);

  if (Array.isArray(tools)) {
    return tools.map(t => wrapSingleCrewAITool(t, state, reporter)) as unknown as T;
  }

  const wrappedObj = {} as any;
  for (const [key, toolDef] of Object.entries(tools)) {
    wrappedObj[key] = wrapSingleCrewAITool(toolDef, state, reporter);
  }

  return wrappedObj as T;
}

function wrapSingleCrewAITool(toolDef: any, state: MovenRunState, reporter: MovenReporter) {
  if (!toolDef || typeof toolDef !== 'object') return toolDef;

  const toolName = toolDef.name || toolDef.id || 'crewai_tool';
  const originalRun = toolDef.run || toolDef._run || toolDef.func || toolDef.execute;

  if (typeof originalRun !== 'function') return toolDef;

  const wrappedRun = async (input: any, ...rest: any[]) => {
    const log = state.recordToolCall(toolName, input);
    state.addCost(0.01);

    const check = MovenHeuristicsEngine.evaluate(state);
    if (check.tripped) {
      await MovenKillHandler.executeKill(check, state, reporter);
    }

    const start = Date.now();
    try {
      const res = await originalRun.call(toolDef, input, ...rest);
      state.recordToolResult(log, res, Date.now() - start);

      const postCheck = MovenHeuristicsEngine.evaluate(state);
      if (postCheck.tripped) {
        await MovenKillHandler.executeKill(postCheck, state, reporter);
      }

      return res;
    } catch (err: any) {
      if (err?.name === 'MovenKillError') throw err;
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
