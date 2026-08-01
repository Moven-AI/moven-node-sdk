import { MovenOptions } from '../core/run-state';
/**
 * Wraps LlamaIndex BaseTool / FunctionTool objects or arrays for Moven circuit breaker protection.
 * Intercepts tool .call() and .acall() executions, updates run-state, checks heuristics, and trips circuit breaker on limit violation.
 */
export declare function wrapLlamaIndexTools<T extends Record<string, any> | Array<any>>(tools: T, options?: MovenOptions): T;
