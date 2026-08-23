import { MovenRunState, MovenOptions } from '../core/run-state';
import { MovenHeuristicsEngine } from '../core/heuristics';
import { MovenKillHandler } from '../kill/abort';
import { MovenReporter } from '../reporter';

/**
 * Universal Wrapper for Custom AI Agents & Custom SDKs
 * Wraps any arbitrary function or tool execution with Moven AI Circuit Breaker.
 *
 * @param toolName Name of the tool or action being executed
 * @param fn Custom tool execution function
 * @param options Moven circuit breaker options
 * @param sharedState Optional shared MovenRunState for multi-tool or multi-step execution sessions
 */
export function wrapCustomTool<T extends (...args: any[]) => Promise<any>>(
  toolName: string,
  fn: T,
  options?: MovenOptions,
  sharedState?: MovenRunState
): T {
  const optsWithProvider = { provider: 'custom-sdk', ...options };
  const state = sharedState || new MovenRunState(optsWithProvider);
  const reporter = new MovenReporter(options?.apiKey, options?.endpoint);

  const wrapped = async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const log = state.recordToolCall(toolName, args[0]);

    // Check heuristics before execution
    const preCheck = MovenHeuristicsEngine.evaluate(state);
    await MovenKillHandler.handleTripResult(preCheck, state, reporter);

    const start = Date.now();
    try {
      const result = await fn(...args);
      state.recordToolResult(log, result, Date.now() - start);

      const postCheck = MovenHeuristicsEngine.evaluate(state);
      await MovenKillHandler.handleTripResult(postCheck, state, reporter);

      return result;
    } catch (err) {
      if ((err as any)?.name === 'MovenKillError') throw err;
      throw err;
    }
  };

  return wrapped as T;
}

/**
 * Universal Wrapper for Custom Class/Object SDK Tool Registries
 * Accepts an object map of custom tools or functions and wraps every tool function automatically.
 */
export function wrapCustomToolRegistry<T extends Record<string, (...args: any[]) => Promise<any>>>(
  tools: T,
  options?: MovenOptions
): T {
  const state = new MovenRunState({ provider: 'custom-sdk', ...options });
  const wrapped: Record<string, any> = {};

  for (const [name, fn] of Object.entries(tools)) {
    if (typeof fn === 'function') {
      wrapped[name] = wrapCustomTool(name, fn, options, state);
    } else {
      wrapped[name] = fn;
    }
  }

  return wrapped as T;
}

/**
 * Developer-Friendly Universal Function Wrapper
 * Can be called as `movenGuard(fn, options)` or `movenGuard('tool_name', fn, options)`
 */
export function movenGuard<T extends (...args: any[]) => Promise<any>>(
  nameOrFn: string | T,
  fnOrOptions?: T | MovenOptions,
  options?: MovenOptions
): T {
  if (typeof nameOrFn === 'function') {
    const fn = nameOrFn;
    const opts = (fnOrOptions as MovenOptions) || {};
    const inferredName = fn.name || 'custom_tool';
    return wrapCustomTool(inferredName, fn, opts);
  } else {
    const name = nameOrFn;
    const fn = fnOrOptions as T;
    return wrapCustomTool(name, fn, options);
  }
}
