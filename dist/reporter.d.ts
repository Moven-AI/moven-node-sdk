import { MovenKillError } from './core/errors';
import { MovenRunState } from './core/run-state';
import type { RewindReceipt } from './core/rewind';
export interface MovenReporterOptions {
    apiKey?: string;
    endpoint?: string;
    maxRetries?: number;
    timeoutMs?: number;
    batchIntervalMs?: number;
    zeroDataRetention?: boolean;
}
export declare class MovenReporter {
    private apiKey?;
    private endpoint;
    private maxRetries;
    private timeoutMs;
    private zeroDataRetention;
    constructor(apiKeyOrOptions?: string | MovenReporterOptions, endpoint?: string);
    sendPayload(payload: any): Promise<boolean>;
    private fetchWithRetry;
    queryJudgeArbitrator(state: MovenRunState): Promise<{
        judgeModel: string;
        cheaperModel: string;
        pricing?: {
            promptPerMillion: number;
            completionPerMillion: number;
        };
        reason?: string;
    } | null>;
    reportKillEvent(error: MovenKillError, state: MovenRunState): Promise<boolean>;
    /**
     * Persists a rewind receipt to api.moven.dev → `rewind_receipts` +
     * `rewind_call_outcomes` + `tool_cooldowns` + `agent_halt_state` tables,
     * and upserts the registered compensations (inverse operations) into
     * `tool_compensations` so the dashboard can show exactly what is reversible.
     */
    reportRewindReceipt(receipt: RewindReceipt, state: MovenRunState): Promise<boolean>;
    /**
     * Reports a completed normal trace execution with full prompt, spans, and checkpoints.
     */
    reportTrace(state: MovenRunState, extra?: Record<string, any>): Promise<boolean>;
    /**
     * Sends the agent's initial configuration to the backend on run start.
     * This upserts the agent record in the `agents` table so the dashboard
     * always reflects the live SDK settings (thresholds, cheaper model, etc).
     */
    reportRunStart(state: MovenRunState): Promise<void>;
}
