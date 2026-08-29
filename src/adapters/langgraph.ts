import { MovenRunState, MovenOptions, MovenGuardWarning } from '../core/run-state';
import { MovenReporter } from '../reporter';
import { MovenRewindEngine, RewindReceipt, RewindOptions } from '../core/rewind';
import { CompensationInput } from '../core/checkpoint';
import { wrapToolsWithState } from './vercel-ai-sdk';
import { withMovenWarnings, buildWarningText } from './model-warnings';
import { MovenLogger } from '../core/logger';

// Public API compatibility — the warning helpers live in model-warnings.ts
// (shared with the universal breaker) and are re-exported here.
export { withMovenWarnings, buildWarningText };

/**
 * LangGraph / LangChain / Vercel model wrapper — the "self-correction" tier
 * of the circuit breaker.
 *
 * Instead of jumping straight to a kill, the breaker queues PRE-TRIP
 * warnings when a repeat pattern is one call away from tripping. The model
 * wrapper drains those warnings and injects them into the NEXT model
 * invocation as a system-style notice, so the LLM can change strategy
 * (vary arguments, switch tools, summarize) before the kill executes.
 *
 *   [agent loop]
 *     tool call #N-1 (warning zone)  ──▶ state.pushWarning(...)
 *     model invocation               ──▶ wrapModel injects the warning
 *     tool call #N: model changed approach  → breaker stays closed ✅
 *     tool call #N: same mistake            → MovenKillError 🛑
 *
 * Zero-dependency: works with LangChain BaseChatModel instances, plain
 * model functions, and Vercel AI SDK model objects. Message coercion is
 * left to the framework (LangChain coerces `{role, content}` automatically;
 * Vercel ModelMessage is natively shape-compatible).
 */

/**
 * Wraps a LangGraph / LangChain chat model (BaseChatModel instance or async
 * function) so every invocation carries the breaker's pending warnings.
 * Works with .invoke, .stream and .bindTools surfaces; all other properties
 * are preserved on the wrapper.
 */
export function wrapModelWithMoven<T>(model: T, state: MovenRunState): T {
  if (!model) return model;

  const injectArgs = (args: any[]): any[] => {
    if (args.length === 0) return args;
    const first = args[0];
    if (Array.isArray(first)) {
      const warned = withMovenWarnings(state, first);
      if (warned !== first) return [warned, ...args.slice(1)];
      return args;
    }
    // Models invoked with a single string prompt: wrap it.
    if (typeof first === 'string') {
      const warnings = state.peekWarnings();
      if (warnings.length === 0) return args;
      const text = buildWarningText(state.drainWarnings());
      return [`${first}\n\n${text}`, ...args.slice(1)];
    }
    return args;
  };

  // Function-style model
  if (typeof model === 'function') {
    const wrapped = async (...args: any[]) => (model as any)(...injectArgs(args));
    return wrapped as unknown as T;
  }

  // Object-style model (BaseChatModel / Runnable-like): prototype-preserving wrapper
  const wrapper: any = Object.create(Object.getPrototypeOf(model));
  Object.assign(wrapper, model);

  const wrapMethod = (name: string) => {
    const original = (model as any)[name];
    if (typeof original !== 'function') return;
    wrapper[name] = function (this: any, ...args: any[]) {
      const nextArgs = injectArgs(args);
      const result = original.apply(this === wrapper ? model : this, nextArgs);
      // Wrap the runnable returned by .bindTools etc. so its invoke also injects.
      if (result && typeof result === 'object' && typeof result.invoke === 'function' && !(result as any).__movenWrapped) {
        const inner = result as any;
        const innerWrapped: any = Object.create(Object.getPrototypeOf(inner));
        Object.assign(innerWrapped, inner);
        innerWrapped.invoke = async (...invokeArgs: any[]) => inner.invoke(...injectArgs(invokeArgs));
        (innerWrapped as any).__movenWrapped = true;
        return innerWrapped;
      }
      return result;
    };
  };

  for (const name of ['invoke', 'stream', 'batch', 'bindTools']) {
    wrapMethod(name);
  }
  (wrapper as any).__movenWrapped = true;
  return wrapper;
}

export interface MovenLangGraphGuard {
  state: MovenRunState;
  reporter: MovenReporter;
  /** Wraps the chat model — pre-trip warnings are injected into every invocation. */
  wrapModel: <T>(model: T) => T;
  /** Wraps LangGraph tool definitions — interception, heuristics, kill/pause/fallback. */
  wrapTools: <T extends Record<string, any>>(tools: T) => { tools: T; state: MovenRunState; reporter: MovenReporter };
  /** Manually drain pending warnings (e.g. for custom prompt templating). */
  drainWarnings: () => MovenGuardWarning[];
  getModel: () => string;
  getActiveModel: () => string;
  isFallback: () => boolean;
  isHalted: () => boolean;
  rewind: (opts?: RewindOptions) => Promise<RewindReceipt | null>;
  resolveHalt: (decision: 'resume' | 'replan' | 'discard', opts?: { clearCooldown?: boolean }) => unknown;
  registerCompensation: (toolName: string, comp: CompensationInput) => void;
  updateSettings: (newOptions: Partial<MovenOptions>) => Promise<MovenOptions>;
}

/**
 * The LangGraph entry point: ONE guard object that wires the breaker into
 * both sides of the loop — the tools (interception + kill) and the model
 * (pre-trip warnings so the LLM can self-correct before the kill).
 *
 * ```ts
 * import { createMovenLangGraphGuard } from 'moven-sdk';
 * const guard = createMovenLangGraphGuard({ agentName: 'research-agent', maxRepeatCalls: 3 });
 * const llm = guard.wrapModel(new ChatOpenAI({ model: 'gpt-4o' }));
 * const tools = guard.wrapTools({ search_web, fetch_page }).tools;
 * // …LangGraph node: llm.invoke(messages) receives the breaker's warnings.
 * ```
 */
export function createMovenLangGraphGuard(options?: MovenOptions): MovenLangGraphGuard {
  const state = new MovenRunState(options);
  const reporter = new MovenReporter(options?.apiKey, options?.endpoint);
  // Expose the reporter to withMovenWarnings without changing its signature
  (state as any).__movenReporter = reporter;

  // Ongoing-conversation user messages attest human-directed repetition
  const messages = (options as any)?.messages;
  if (Array.isArray(messages) && messages.length > 1) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === 'user') {
        const content = typeof m.content === 'string' ? m.content : '';
        if (content.trim()) state.recordUserInstruction(content);
        break;
      }
    }
  }

  reporter.reportRunStart(state);

  return {
    state,
    reporter,
    wrapModel: <T>(model: T): T => wrapModelWithMoven(model, state),
    wrapTools: <T extends Record<string, any>>(tools: T) => {
      const wrapped = wrapToolsWithState(tools, state, reporter, options);
      return { tools: wrapped as T, state, reporter };
    },
    drainWarnings: () => state.drainWarnings(),
    getModel: () => state.activeModel,
    getActiveModel: () => state.activeModel,
    isFallback: () => state.isFallbackActive,
    isHalted: () => state.halted,
    rewind: async (opts?: RewindOptions) => MovenRewindEngine.rewind(state, reporter, opts),
    resolveHalt: (decision: 'resume' | 'replan' | 'discard', opts?: { clearCooldown?: boolean }) =>
      MovenRewindEngine.resolve(state, decision, opts),
    registerCompensation: (toolName: string, comp: CompensationInput) => state.registerCompensation(toolName, comp),
    updateSettings: async (newOptions: Partial<MovenOptions>) => {
      state.updateOptions(newOptions);
      await reporter.reportRunStart(state);
      return state.options;
    },
  };
}
