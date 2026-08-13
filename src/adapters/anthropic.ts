import { MovenRunState, MovenOptions } from '../core/run-state';
import { MovenHeuristicsEngine } from '../core/heuristics';
import { MovenKillHandler } from '../kill/abort';
import { MovenReporter } from '../reporter';

export function wrapAnthropicToolUse<T extends (...args: any[]) => Promise<any>>(
  toolName: string,
  handler: T,
  options?: MovenOptions,
  sharedState?: MovenRunState
): T {
  const optsWithProvider = { provider: 'anthropic', ...options };
  const state = sharedState || new MovenRunState(optsWithProvider);
  const reporter = new MovenReporter(options?.apiKey, options?.endpoint);

  const wrapped = async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const log = state.recordToolCall(toolName, args[0]);

    const check = MovenHeuristicsEngine.evaluate(state);
    await MovenKillHandler.handleTripResult(check, state, reporter);

    const start = Date.now();
    try {
      const res = await handler(...args);
      state.recordToolResult(log, res, Date.now() - start);

      const postCheck = MovenHeuristicsEngine.evaluate(state);
      await MovenKillHandler.handleTripResult(postCheck, state, reporter);

      return res;
    } catch (err) {
      if ((err as any)?.name === 'MovenKillError') throw err;
      throw err;
    }
  };

  return wrapped as T;
}
