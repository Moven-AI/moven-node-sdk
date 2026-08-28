import { MovenKillMetrics } from './errors';
import { BurnGuardOptions } from './burn-guard';
import { SemanticCacheOptions } from './semantic-cache';
import { MovenCheckpointManager, MovenCompensationRegistry, CompensationInput } from './checkpoint';
import { SemanticFingerprintOptions } from './semantic-fingerprint';
import { PromptFirewallConfig } from './prompt-firewall';
import { Layer2Options, MovenLayer2Guard, Layer2DecisionResult } from './layer2';
export type ToolCallStatus = 'queued' | 'in_flight' | 'committed' | 'cancelled';
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
    /**
     * Idempotency key. Auto-generated per unique call and injected into args so
     * downstream APIs (Stripe, DBs) can dedupe — prevents double-fire when a
     * call is retried after a rewind.
     */
    idempotencyKey?: string;
    /** Lifecycle: queued → in_flight → committed | cancelled */
    status: ToolCallStatus;
    /** Convenience flag: true only when the call reached the downstream API and returned */
    committed?: boolean;
    /** Depth/step of this call (matches the checkpoint created just before it) */
    depth?: number;
    /** Estimated/actual tokens consumed by this single tool step (including model dispatch) */
    tokens?: number;
    /** Prompt tokens attributed to this step */
    promptTokens?: number;
    /** Completion tokens attributed to this step */
    completionTokens?: number;
    /** Dollar cost attributed to this single step */
    cost?: number;
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
    userRequest?: string;
    goal?: string;
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
    enableSemanticCache?: boolean;
    semanticCache?: SemanticCacheOptions;
    enableSemanticFingerprint?: boolean;
    semanticFingerprint?: SemanticFingerprintOptions;
    enablePromptInjectionFirewall?: boolean;
    promptFirewall?: PromptFirewallConfig;
    layer2?: Layer2Options;
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
    /** Bounded checkpoint retention window (default 50 turns) */
    maxCheckpoints?: number;
    /**
     * Compensating actions (saga pattern) registered at construction:
     * { create_row: (args, result) => db.delete_row(result.id) } or
     * { 'stripe.charge': { type: 'api_call', name: 'stripe.refund_charge', config: {...} } }
     */
    compensations?: Record<string, CompensationInput>;
    /** Auto-inject generated idempotency keys into tool args (default: true) */
    autoInjectIdempotencyKey?: boolean;
    /** Default cooldown applied to the offending tool after a rewind (default 300s) */
    rewindCooldownSeconds?: number;
    /** Per-tool inline compensating action for adapter wrappers: movenGuard('create_row', fn, { compensate: (args, result) => db.delete_row(result.id) }) */
    compensate?: CompensationInput;
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
    onRewind?: (receipt: any) => void;
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
    /** Layer 2: Semantic Guard In-Process Instance */
    layer2Guard: MovenLayer2Guard;
    /** Latest Layer 2 decision result */
    lastLayer2Result?: Layer2DecisionResult;
    /** Agent context / plan. Deep-copied into every checkpoint; restored on rewind. */
    context: Record<string, any>;
    /** Working scratchpad (intermediate values, partial results). Checkpointed + restored. */
    scratchpad: Record<string, any>;
    /** Per-tool retry counters. Checkpointed + restored on rewind. */
    retryCounts: Record<string, number>;
    /** After a rewind the agent is halted — a human decision or re-plan is required. */
    halted: boolean;
    haltReason?: string;
    /** Set when the operator forces a re-plan step instead of a blind resume. */
    replanRequested: boolean;
    /** toolName (or toolName:argsHash) → cooldown expiry epoch ms */
    toolCooldowns: Map<string, number>;
    /** Compensating-action registry (saga) — used by the rewind engine */
    readonly compensations: MovenCompensationRegistry;
    /** Ctrl+Z checkpoint ledger (bounded retention) */
    checkpointManager: MovenCheckpointManager;
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
    isSafeToRetryTool(toolName: string): boolean;
    isReadOnlyTool(toolName: string): boolean;
    /**
     * The interception point. Called BEFORE the real tool body runs — checks
     * the halt gate and cooldowns synchronously so a blocked call can never
     * reach the network (zero-proxy, in-process interception).
     * Throws MovenKillError when the call must not execute.
     */
    private interceptionGuard;
    recordToolCall(toolName: string, args: any): ToolCallLog;
    /** Registers a call as queued (scheduled but not started). Not checkpointed, not costed. */
    queueToolCall(toolName: string, args: any): ToolCallLog;
    /** All calls that have been dispatched but have not committed (or been cancelled). */
    pendingCalls(): ToolCallLog[];
    /** Cancels every queued / in-flight call. Returns the cancelled logs. */
    cancelPending(): ToolCallLog[];
    recordToolResult(logOrResult: ToolCallLog | any, result?: any, durationMs?: number): void;
    updateContext(patch: Record<string, any>): void;
    updateScratchpad(patch: Record<string, any>): void;
    incrementRetry(toolName: string): number;
    /** Register a compensating action (saga inverse) for a tool. */
    registerCompensation(toolName: string, input: CompensationInput): void;
    /**
     * Puts a tool on cooldown. Returns the cooldown expiry (epoch ms).
     * With argsHash the cooldown targets the identical call; without it the
     * whole tool is blocked — safer for incident response.
     */
    applyCooldown(toolName: string | undefined, seconds?: number, argsHash?: string): number;
    isToolOnCooldown(toolName: string, argsHash?: string): boolean;
    cooldownRemainingMs(toolName?: string): number;
    clearCooldowns(): void;
    /**
     * Mechanism 1 rewind: pointer restoration of in-process orchestration state.
     * External side effects are NOT touched here — the rewind engine handles
     * sagas/manual-review for committed calls before invoking this.
     * Returns the number of truncated (forgotten) tool-call log entries.
     */
    restoreFromCheckpoint(ckpt: {
        context?: Record<string, any>;
        scratchpad?: Record<string, any>;
        retryCounts?: Record<string, number>;
        messagesSnapshot?: any[];
        model?: string;
        cumulativeCost: number;
        stepIndex: number;
        timestamp: number;
    }): number;
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
