import { MovenRunState, MovenOptions } from '../core/run-state';
import { MovenHeuristicsEngine } from '../core/heuristics';
import { MovenKillError } from '../core/errors';
import { MovenKillHandler } from '../kill/abort';
import { MovenReporter } from '../reporter';
import { MovenRewindEngine, RewindOptions, RewindReceipt } from '../core/rewind';
import { recordToolCallSpan, MovenOtelExporter } from '../otel';

/**
 * Universal Wrapper for Custom AI Agents & Custom SDKs
 * Wraps any arbitrary function or tool execution with Moven AI Circuit Breaker.
 *
 * The wrapped function exposes a `moven` handle (state / reporter / rewind /
 * resolveHalt) so custom-SDK integrations get the same Ctrl+Z rewind
 * capability as the Vercel AI SDK adapter.
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
  const optsWithProvider = { provider: options?.provider || 'custom-sdk', ...options };
  const state = sharedState || new MovenRunState(optsWithProvider);
  const reporter = new MovenReporter(options?.apiKey, options?.endpoint);

  // Saga: register the inline compensating action (inverse) for this tool
  if (options?.compensate) {
    state.registerCompensation(toolName, options.compensate);
  }

  const wrapped = async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const log = state.recordToolCall(toolName, args[0]);
    const start = Date.now();

    try {
      // Check heuristics before execution
      const preCheck = MovenHeuristicsEngine.evaluate(state);
      await MovenKillHandler.handleTripResult(preCheck, state, reporter);

      const result = await fn(...args);
      const latencyMs = Date.now() - start;
      state.recordToolResult(log, result, latencyMs);
      recordToolCallSpan({
        toolName,
        runId: state.runId,
        agentId: state.agentId,
        agentName: state.agentName,
        decision: 'ALLOW',
        cost: log.cost,
        latencyMs,
        startedAt: start,
        durationMs: latencyMs,
      });

      const postCheck = MovenHeuristicsEngine.evaluate(state);
      await MovenKillHandler.handleTripResult(postCheck, state, reporter);

      return result;
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      const isKill = err?.name === 'MovenKillError';
      const isPause = err?.name === 'MovenPauseError';
      recordToolCallSpan({
        toolName,
        runId: state.runId,
        agentId: state.agentId,
        agentName: state.agentName,
        decision: isKill ? 'KILL' : isPause ? 'PAUSE' : 'WARN',
        cost: log.cost,
        latencyMs,
        error: !isPause,
        reason: isKill || isPause ? err?.reason : err?.message,
        startedAt: start,
        durationMs: latencyMs,
      });
      if (isKill) {
        void MovenOtelExporter.flush();
        // Opt-in auto-rewind: run the honest rewind (saga compensations +
        // halt + cooldown + receipt) before surfacing the kill error.
        if (state.options.autoRewindOnKill && !err.__movenRewound) {
          try {
            err.__movenRewound = true;
            const receipt = await MovenRewindEngine.rewind(state, reporter, {
              triggeredBy: 'auto',
              offendingTool: err.toolName || toolName,
            });
            (err as any).rewindReceipt = receipt;
          } catch {
            // Never mask the kill error with a rewind failure
          }
        }
        throw err;
      }
      if (isPause) throw err;
      // Record the failure so the call doesn't stay in_flight forever — the
      // rewind receipt then reflects it honestly (reached the downstream API).
      state.recordToolResult(log, { error: err?.message || String(err) }, Date.now() - start);
      throw err;
    }
  };

  // Expose the run controls on the wrapped function so custom integrations
  // can drive the Ctrl+Z rewind / halt resolution without the Vercel adapter.
  (wrapped as any).moven = {
    state,
    reporter,
    rewind: async (opts?: RewindOptions): Promise<RewindReceipt | null> =>
      MovenRewindEngine.rewind(state, reporter, opts),
    resolveHalt: (decision: 'resume' | 'replan' | 'discard', opts?: { clearCooldown?: boolean }) =>
      MovenRewindEngine.resolve(state, decision, opts),
    registerCompensation: (name: string, comp: any) => state.registerCompensation(name, comp),
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
  const state = new MovenRunState({ provider: options?.provider || 'custom-sdk', ...options });
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
 *
 * NOTE: each top-level movenGuard() call gets its own MovenRunState (and its
 * own cost budget) unless you pass a shared state via init:
 *   moven.init({...}); moven.guard(fn)  → all moven.guard()ed fns share one state.
 * For manual sharing use wrapCustomTool(name, fn, opts, sharedState).
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
