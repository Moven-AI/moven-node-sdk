import { MovenKillError } from './core/errors';
import { MovenRunState } from './core/run-state';
export interface MovenReporterOptions {
    apiKey?: string;
    endpoint?: string;
    maxRetries?: number;
    timeoutMs?: number;
    batchIntervalMs?: number;
}
export declare class MovenReporter {
    private apiKey?;
    private endpoint;
    private maxRetries;
    private timeoutMs;
    constructor(apiKeyOrOptions?: string | MovenReporterOptions, endpoint?: string);
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
     * Sends the agent's initial configuration to the backend on run start.
     * This upserts the agent record in the `agents` table so the dashboard
     * always reflects the live SDK settings (thresholds, cheaper model, etc).
     */
    reportRunStart(state: MovenRunState): Promise<void>;
}
