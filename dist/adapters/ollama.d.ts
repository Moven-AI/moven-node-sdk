import { MovenOptions } from '../core/run-state';
/**
 * Wraps Ollama / Local LLM tool definitions for Moven circuit breaker protection.
 */
export declare function wrapOllamaTools<T extends Record<string, any>>(tools: T, options?: MovenOptions): T;
