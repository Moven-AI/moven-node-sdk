import { MovenOptions } from '../core/run-state';
/**
 * Wraps AWS Bedrock / Converse API tool invocations for Moven circuit breaker protection.
 */
export declare function wrapBedrockTools<T extends Record<string, any>>(tools: T, options?: MovenOptions): T;
