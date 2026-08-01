import { MovenOptions } from '../core/run-state';
/**
 * Wraps Cohere Command / Command-R tool handlers for Moven circuit breaker protection.
 */
export declare function wrapCohereTools<T extends Record<string, any>>(tools: T, options?: MovenOptions): T;
