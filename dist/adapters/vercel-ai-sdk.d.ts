import { MovenRunState, MovenOptions } from '../core/run-state';
import { MovenReporter } from '../reporter';
/**
 * Wraps tool definitions for Vercel AI SDK generateText/streamText.
 * Intercepts tool execution, updates run-state, checks heuristics, and trips circuit breaker on limit violation.
 */
export declare function wrapToolsWithMoven<T extends Record<string, any>>(tools: T, options?: MovenOptions): {
    tools: T;
    state: MovenRunState;
    reporter: MovenReporter;
};
export declare function createMovenCircuitBreaker(options?: MovenOptions): {
    state: MovenRunState;
    reporter: MovenReporter;
    getModel: () => string;
    getActiveModel: () => string;
    isFallback: () => boolean;
    updateSettings: (newOptions: Partial<MovenOptions>) => Promise<MovenOptions>;
    syncWithCloud: () => Promise<MovenOptions>;
    wrapTools: <T extends Record<string, any>>(tools: T) => T & {
        tools: T;
        state: MovenRunState;
        reporter: MovenReporter;
    };
};
