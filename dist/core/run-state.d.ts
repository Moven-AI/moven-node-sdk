import { MovenKillMetrics } from './errors';
import { BurnGuardOptions } from './burn-guard';
import { SemanticCacheOptions } from './semantic-cache';
import { MovenCheckpointManager } from './checkpoint';
import { SemanticFingerprintOptions } from './semantic-fingerprint';
export interface ToolCallLog {
    toolName: string;
    args: any;
    argsHash: string;
    timestamp: number;
    result?: any;
    resultHash?: string;
    isResultProgressive?: boolean;
    durationMs?: number;
    /** Optional: the agent's raw reasoning/thought text that preceded this tool call */
    reasoning?: string;
    /** Goal-state hash of (reasoning intent + tool result) — set after recordToolResult */
    intentHash?: string;
    /** Optional idempotency key passed with write tool */
    idempotencyKey?: string;
    /** True if tool is recognized as safe-to-retry / long-running poll */
    isPollingTool?: boolean;
    /** True if tool is read-only (e.g. get_, fetch_, search_) */
    isReadOnly?: boolean;
}
export interface MovenOptions {
    runId?: string;
    agentId?: string;
    agentName?: string;
    framework?: string;
    version?: string;
    tags?: string[];
    allowedTools?: string[];
    maxRepeatCalls?: number;
    repeatTimeWindowMs?: number;
    maxCostDollar?: number;
    maxDepth?: number;
    maxNoProgressTurns?: number;
    judgeModel?: string;
    provider?: 'openai' | 'anthropic' | 'google' | 'cohere' | 'mistral' | 'groq' | 'openrouter' | string;
    modelAuthor?: string;
    currentModel?: string;
    cheaperModel?: string;
    cheaperModelMap?: Record<string, string>;
    autoFallbackCheaperModel?: boolean;
    enableLlmJudgeArbitrator?: boolean;
    burnGuard?: BurnGuardOptions;
    semanticCache?: SemanticCacheOptions;
    semanticFingerprint?: SemanticFingerprintOptions;
    /** Enable Result-Delta Hashing to distinguish legitimate status polling from stagnant loops (default: true) */
    enableResultDeltaProgression?: boolean;
    /** List of tool names that are whitelisted as safe-to-retry long-running polls (bypasses repeat count, governed by pollingTtlSeconds) */
    safeToRetryTools?: string[];
    /** Maximum duration in seconds allowed for a polling loop before tripping (default: 600 = 10 minutes) */
    pollingTtlSeconds?: number;
    /** List of read-only tool names/prefixes that receive relaxed repeat limits */
    readOnlyTools?: string[];
    /** Dry Run simulation mode: Evaluates and reports all circuit trips without terminating execution (default: false) */
    dryRun?: boolean;
    /** Soft Trip / Pause & Ask: Pauses agent and emits notification instead of immediately killing on ambiguous trips */
    pauseOnTrip?: boolean;
    /** Historical 95th-percentile step baseline for adaptive threshold scaling */
    percentileStepBaseline?: number;
    /** Tool names that should be gated by the async LLM Judge before execution (e.g. 'sendEmail', 'writeToDb') */
    highRiskTools?: string[];
    promptCostPerMillion?: number;
    completionCostPerMillion?: number;
    apiKey?: string;
    endpoint?: string;
    onKill?: (error: any) => void;
    onPause?: (info: {
        agentName: string;
        reason: string;
        toolName?: string;
        args?: any;
        resumeToken: string;
    }) => void;
    onHallucination?: (info: {
        agentName: string;
        reason: string;
        toolName?: string;
        args?: any;
    }) => void;
    customCheck?: (state: MovenRunState) => {
        tripped: boolean;
        reason: string;
    } | null;
}
export declare const DEFAULT_CHEAPER_MODEL_MAP: Record<string, string>;
export declare class MovenRunState {
    readonly runId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly framework: string;
    readonly version: string;
    readonly tags: string[];
    readonly startTime: number;
    toolCalls: ToolCallLog[];
    depth: number;
    cumulativeCost: number;
    stateHashes: string[];
    isKilled: boolean;
    activeModel: string;
    isFallbackActive: boolean;
    cleanTurnsCount: number;
    options: MovenOptions;
    /** Sliding window of the last N agent reasoning/thought strings */
    reasoningSteps: string[];
    /** Parallel array of goal-state hashes computed after each tool result */
    intentHashes: string[];
    /** Latest Progress Delta cosine similarity score (0–1). Updated on each evaluate(). */
    lastSemanticSimilarity: number;
    constructor(options?: MovenOptions);
    getModel(): string;
    getActiveModel(): string;
    switchToCheaperModel(): string;
    registerCleanTurn(): boolean;
    updateOptions(newRules: Partial<MovenOptions>): void;
    getCheaperModel(providerOrModel?: string): string;
    readonly checkpointManager: MovenCheckpointManager;
    isSafeToRetryTool(toolName: string): boolean;
    isReadOnlyTool(toolName: string): boolean;
    recordToolCall(toolName: string, args: any): ToolCallLog;
    recordToolResult(logOrResult: ToolCallLog | any, result?: any, durationMs?: number): void;
    /**
     * Record the agent's reasoning/thought text for the current step.
     * Call this after receiving the LLM response, before calling recordToolCall.
     * Compatible with: Claude <thinking>, OpenAI o-series reasoning, LangChain thought fields.
     */
    recordReasoning(step: string): void;
    /**
     * Returns true if the given tool name is declared as high-risk by the user,
     * meaning the async LLM Judge must confirm progress before it executes.
     */
    isHighRiskTool(toolName: string): boolean;
    addCost(cost: number): void;
    getMetrics(): MovenKillMetrics;
    /**
     * Calculates recent repeat calls with Result-Delta Hashing and Polling Whitelisting.
     * - If output state is progressing (status changes from pending -> building -> done), repeat count resets.
     * - If tool is safe-to-retry / polling, it is allowed up to pollingTtlSeconds (default 600s).
     * - If tool is read-only, threshold receives relaxed headroom.
     */
    getRecentRepeatCallsCount(timeWindowMs?: number): number;
    private canonicalStringify;
    private hashArguments;
    hashResultState(result: any): string;
    private hashStateTurn;
}
