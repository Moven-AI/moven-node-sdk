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
    userId?: string;
    userEmail?: string;
    metadata?: Record<string, any>;
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
    model?: string;
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
    /** Maximum error failure rate percentage over sliding request window before circuit opens (default: 50%) */
    maxErrorRatePct?: number;
    /** Latency threshold in ms for marking a slow / degraded model call (default: 30,000ms = 30s) */
    maxSlowCallLatencyMs?: number;
    /** Maximum percentage of slow calls over sliding window before tripping (default: 40%) */
    maxSlowCallRatePct?: number;
    /** Maximum consecutive JSON structural / schema validation failures before trip (default: 3) */
    maxSchemaValidationFailures?: number;
    /** Maximum token burst limit per single LLM step outside tool wrappers (default: 8,192 tokens) */
    maxTokensPerStep?: number;
    /** Real-time structural JSON validation detector (default: true) */
    enableStructuralValidation?: boolean;
    /** Enable coordinated organization-wide backoff on upstream provider degradation (default: true) */
    enableGlobalBackoff?: boolean;
    /** Sliding window size in requests for calculating error and slow call rates (default: 20) */
    slidingWindowRequests?: number;
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
    cumulativePromptTokens: number;
    cumulativeCompletionTokens: number;
    cumulativeTotalTokens: number;
    cumulativeCost: number;
    stateHashes: string[];
    isKilled: boolean;
    activeModel: string;
    isFallbackActive: boolean;
    cleanTurnsCount: number;
    options: MovenOptions;
    /** User request / prompt driving this run */
    userRequest: string;
    /** System prompt defining agent role and constraints */
    systemPrompt: string;
    /** Chronological history of prompt turns (user, assistant, tool, system) */
    prompts: {
        role: string;
        content: string;
        timestamp: number;
    }[];
    /** Sliding window of the last N agent reasoning/thought strings */
    reasoningSteps: string[];
    /** Parallel array of goal-state hashes computed after each tool result */
    intentHashes: string[];
    /** Latest Progress Delta cosine similarity score (0–1). Updated on each evaluate(). */
    lastSemanticSimilarity: number;
    /** SRE Telemetry: Sliding window of recent call statuses (true = success, false = error) */
    recentCallOutcomes: {
        timestamp: number;
        success: boolean;
        latencyMs: number;
        isSchemaFailure?: boolean;
    }[];
    /** Consecutive structural schema validation failures counter */
    consecutiveSchemaFailures: number;
    /** Max tokens generated in a single step (burst tracking) */
    lastStepTokenCount: number;
    /** Global backoff epoch in ms */
    globalBackoffUntil: number;
    constructor(options?: MovenOptions);
    setUserRequest(request: string): void;
    setSystemPrompt(prompt: string): void;
    recordPrompt(content: string, role?: string): void;
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
    recordCallOutcome(success: boolean, latencyMs?: number, isSchemaFailure?: boolean): void;
    recordSchemaValidationFailure(toolName?: string, errorMsg?: string): void;
    recordStepTokens(promptTokens: number, completionTokens?: number): void;
    getRecentErrorRate(): number;
    getRecentSlowCallRate(thresholdMs?: number): number;
    setGlobalBackoff(durationMs: number): void;
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
    /**
     * Generates the complete ReactFlow / n8n workflow graph JSON representation
     * of this agent run, including triggers, agent node, model/memory/tool subnodes,
     * circuit breaker router, and outcome branches.
     */
    generateWorkflowGraph(options?: {
        isKilled?: boolean;
        errorReason?: string;
    }): {
        nodes: any[];
        edges: any[];
        viewport: {
            x: number;
            y: number;
            zoom: number;
        };
        metadata: Record<string, any>;
    };
}
