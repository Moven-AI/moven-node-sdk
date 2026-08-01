import { MovenOptions } from '../core/run-state';
/**
 * Wraps Groq Llama tool call handlers for Moven circuit breaker protection.
 */
export declare function wrapGroqTools<T extends Record<string, any>>(tools: T, options?: MovenOptions): T;
