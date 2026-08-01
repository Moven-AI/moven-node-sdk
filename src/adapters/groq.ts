import { MovenRunState, MovenOptions } from '../core/run-state';
import { MovenHeuristicsEngine } from '../core/heuristics';
import { MovenKillHandler } from '../kill/abort';
import { MovenReporter } from '../reporter';

/**
 * Wraps Groq Llama tool call handlers for Moven circuit breaker protection.
 */
export function wrapGroqTools<T extends Record<string, any>>(
  tools: T,
  options?: MovenOptions
): T {
  const optsWithProvider = { provider: 'groq', framework: 'Groq SDK', ...options };
  const state = new MovenRunState(optsWithProvider);
  const reporter = new MovenReporter(options?.apiKey, options?.endpoint);

  reporter.reportRunStart(state);

  const wrappedObj = {} as any;

  for (const [toolName, toolDef] of Object.entries(tools)) {
    if (!toolDef) continue;
    const fn = typeof toolDef === 'function' ? toolDef : (toolDef.execute || toolDef.func || toolDef.run);
    if (typeof fn !== 'function') {
      wrappedObj[toolName] = toolDef;
      continue;
    }

    const wrappedFn = async (...args: any[]) => {
      const log = state.recordToolCall(toolName, args[0] || args);
      state.addCost(0.005);

      const check = MovenHeuristicsEngine.evaluate(state);
      if (check.tripped) {
        await MovenKillHandler.executeKill(check, state, reporter);
      }

      const start = Date.now();
      try {
        const res = await fn(...args);
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

    if (typeof toolDef === 'function') {
      wrappedObj[toolName] = wrappedFn;
    } else {
      wrappedObj[toolName] = {
        ...toolDef,
        execute: wrappedFn,
      };
    }
  }

  return wrappedObj as T;
}
