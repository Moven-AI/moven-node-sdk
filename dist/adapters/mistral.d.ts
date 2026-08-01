import { MovenOptions } from '../core/run-state';
/**
 * Wraps Mistral AI tool call handlers for Moven circuit breaker protection.
 */
export declare function wrapMistralTools<T extends Record<string, any>>(tools: T, options?: MovenOptions): T;
