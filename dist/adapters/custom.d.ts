import { MovenRunState, MovenOptions } from '../core/run-state';
/**
 * Universal Wrapper for Custom AI Agents & Custom SDKs
 * Wraps any arbitrary function or tool execution with Moven AI Circuit Breaker.
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
