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
 * Core wrapping logic — wraps tool definitions against a GIVEN run state so
 * every entry point (wrapToolsWithMoven, createMovenCircuitBreaker, the
 * LangGraph guard) shares one state. This is what keeps breaker.rewind()
 * operating on the SAME ledger the wrapped tools write to.
 */
export declare function wrapToolsWithState<T extends Record<string, any>>(tools: T, state: MovenRunState, reporter: MovenReporter, options?: MovenOptions): T;
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
    /**
     * Wraps tools against THIS breaker's run state — the same state that
     * rewind()/resolveHalt() operate on, so Ctrl+Z always rewinds the
     * ledger the tools actually wrote to.
     */
    wrapTools: <T extends Record<string, any>>(tools: T) => T & {
        tools: T;
        state: MovenRunState;
        reporter: MovenReporter;
    };
    /**
     * FRAMEWORK-AGNOSTIC WARNING FLOW — works with any SDK (OpenAI, Anthropic,
     * CrewAI, AutoGen, LlamaIndex, raw fetch loops). Call this on your messages
     * array right before EVERY model invocation; pending pre-trip warnings are
     * appended as a final `{ role: 'system', content }` message and drained.
     * Pure — the input array is never mutated.
     */
    warnModel: (messages: any[]) => any[];
    /** Manually drain pending pre-trip warnings (custom prompt templating). */
    drainWarnings: () => import("../core/run-state").MovenGuardWarning[];
    /** Non-destructive peek at queued warnings (dashboards, tests, logging). */
    peekWarnings: () => import("../core/run-state").MovenGuardWarning[];
};
