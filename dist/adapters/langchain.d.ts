import { MovenOptions } from '../core/run-state';
/**
 * Wraps LangChain / LangGraph tool objects or arrays for agent safety.
 * Intercepts tool .invoke() and ._call() executions, updates run state, checks heuristics, and trips circuit breaker on limit violation.
 */
export declare function wrapLangChainTools<T extends Record<string, any> | Array<any>>(tools: T, options?: MovenOptions): T;
