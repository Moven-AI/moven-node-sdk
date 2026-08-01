import { MovenOptions } from '../core/run-state';
/**
 * Wraps AutoGen agent functions/tools for Moven circuit breaker protection.
 * Intercepts tool calls between AutoGen agents, updates run-state, checks heuristics, and trips circuit breaker on limit violation.
 */
export declare function wrapAutoGenTools<T extends Record<string, any> | Array<any>>(tools: T, options?: MovenOptions): T;
