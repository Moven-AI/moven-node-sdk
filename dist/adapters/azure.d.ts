import { MovenOptions } from '../core/run-state';
/**
 * Wraps Azure OpenAI Service tool runner calls with Moven circuit breaker protection.
 */
export declare function wrapAzureOpenAITools<T extends Record<string, any>>(tools: T, options?: MovenOptions): T;
