import { MovenRunState, MovenOptions } from '../core/run-state';
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
export declare function wrapCustomTool<T extends (...args: any[]) => Promise<any>>(toolName: string, fn: T, options?: MovenOptions, sharedState?: MovenRunState): T;
/**
 * Universal Wrapper for Custom Class/Object SDK Tool Registries
 * Accepts an object map of custom tools or functions and wraps every tool function automatically.
 */
export declare function wrapCustomToolRegistry<T extends Record<string, (...args: any[]) => Promise<any>>>(tools: T, options?: MovenOptions): T;
/**
 * Developer-Friendly Universal Function Wrapper
 * Can be called as `movenGuard(fn, options)` or `movenGuard('tool_name', fn, options)`
 *
 * NOTE: each top-level movenGuard() call gets its own MovenRunState (and its
 * own cost budget) unless you pass a shared state via init:
 *   moven.init({...}); moven.guard(fn)  → all moven.guard()ed fns share one state.
 * For manual sharing use wrapCustomTool(name, fn, opts, sharedState).
 */
export declare function movenGuard<T extends (...args: any[]) => Promise<any>>(nameOrFn: string | T, fnOrOptions?: T | MovenOptions, options?: MovenOptions): T;
