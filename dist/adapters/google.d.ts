import { MovenOptions } from '../core/run-state';
/**
 * Wraps Google Gemini SDK FunctionDeclarations and function handlers for Moven circuit breaker protection.
 */
export declare function wrapGoogleGeminiTools<T extends Record<string, any>>(tools: T, options?: MovenOptions): T;
