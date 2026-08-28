import { MovenRunState, MovenOptions } from '../core/run-state';
import { MovenReporter } from '../reporter';
import { RewindReceipt, RewindOptions } from '../core/rewind';
import { CompensationInput } from '../core/checkpoint';
declare module '../core/run-state' {
    interface MovenOptions {
        /** toolDef-level compensating action picked up by wrapToolsWithMoven */
        compensate?: CompensationInput;
    }
}
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
    isHalted: () => boolean;
    /**
     * Honest rewind: restores in-process state, cancels uncommitted calls,
     * runs registered compensations, returns a receipt, halts + cooldowns.
     */
    rewind: (opts?: RewindOptions) => Promise<RewindReceipt | null>;
    /** Operator decision on a halted run: 'resume' | 'replan' | 'discard' */
    resolveHalt: (decision: "resume" | "replan" | "discard", opts?: {
        clearCooldown?: boolean;
    }) => {
        ok: boolean;
        cooldownRemainingMs: number;
    };
    registerCompensation: (toolName: string, comp: CompensationInput) => void;
    updateSettings: (newOptions: Partial<MovenOptions>) => Promise<MovenOptions>;
    syncWithCloud: () => Promise<MovenOptions>;
    wrapTools: <T extends Record<string, any>>(tools: T) => T & {
        tools: T;
        state: MovenRunState;
        reporter: MovenReporter;
    };
};
