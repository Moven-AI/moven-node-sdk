import { MovenOptions } from '../core/run-state';
/**
 * Wraps CrewAI multi-agent tools for Moven circuit breaker protection.
 * Intercepts tool .run(), ._run(), or function execution, updates run-state, checks heuristics, and trips circuit breaker on limit violation.
 */
export declare function wrapCrewAITools<T extends Record<string, any> | Array<any>>(tools: T, options?: MovenOptions): T;
