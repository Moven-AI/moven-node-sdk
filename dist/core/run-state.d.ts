import { MovenKillMetrics } from './errors';
import { BurnGuardOptions } from './burn-guard';
import { SemanticCacheOptions } from './semantic-cache';
import { MovenCheckpointManager, MovenCompensationRegistry, CompensationInput } from './checkpoint';
import { SemanticFingerprintOptions } from './semantic-fingerprint';
import { PromptFirewallConfig } from './prompt-firewall';
import { Layer2Options, MovenLayer2Guard, Layer2DecisionResult } from './layer2';
import { MovenOtelOptions } from '../otel';
export type ToolCallStatus = 'queued' | 'in_flight' | 'committed' | 'cancelled';
/**
 * A PRE-TRIP warning destined for the MODEL: the breaker detected a pattern
 * one step away from tripping and wants the LLM to self-correct before the
 * kill. The LangGraph / Vercel model wrappers drain these and inject them
 * into the next model invocation as a system-style notice.
 */
export interface MovenGuardWarning {
    id: string;
    heuristic: string;
    toolName?: string;
    argsHash?: string;
    /** How many calls remain before the breaker trips. */
    remaining: number;
    message: string;
    createdAt: number;
}
/**
 * The active result of the instruction-intent classifier: describes WHICH
 * calls are human-directed, with what repetition budget, until when.
 */
export interface AttestationProfile {
    /** Epoch ms after which the attestation expires. */
    until: number;
    /** Classifier confidence (0..1) for the directive. */
    confidence: number;
    /** Directive family that triggered. */
    kind: 'explicit_count' | 'again' | 'repeat_verb' | 'persist' | 'none';
    /**
     * Explicit repetition budget extracted from the instruction ("5 times" → 5).
     * When set, the stagnation ceiling for attested calls trips AFTER this many
     * identical results (the user's own stated limit), replacing
     * maxHumanAttestedStagnantSteps.
     */
    repetitionAllowance?: number;
    /** Content terms used for topic→call attribution. */
    topicTerms: string[];
    /** True when the directive carries no topic terms ("do it again") — attests the current call pattern generally. */
    general: boolean;
}
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
    /**
     * True when this call was executed while a human instruction was active
     * (a fresh user prompt opened the attestation window). User-directed
     * repetitions — "search it 5 times" — are legitimate work, so loop
     * heuristics are relaxed for them while the stagnation ceiling and hard
     * limits (cost / depth / burn guard) stay enforced.
     */
    humanAttested?: boolean;
}
export interface MovenOptions {
    runId?: string;
    agentId?: string;
    agentName?: string;
    userId?: string;
    userEmail?: string;
    userRequest?: string;
    userPrompt?: string;
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
    /** @deprecated legacy alias for `fallbackModel` — the cheap model used for fallback routing */
    judgeModel?: string;
    /** Cheap fallback model ID used when routing down (default: 'google/gemini-2.5-flash-lite') */
    fallbackModel?: string;
    provider?: 'openai' | 'anthropic' | 'google' | 'cohere' | 'mistral' | 'groq' | 'openrouter' | string;
    model?: string;
    modelAuthor?: string;
    currentModel?: string;
    cheaperModel?: string;
    cheaperModelMap?: Record<string, string>;
    autoFallbackCheaperModel?: boolean;
    /** Soft (opt-in) cost ceiling: allows 25% headroom when the run is demonstrably making progress. Default: hard ceiling. */
    softCostCeiling?: boolean;
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
    /**
     * How long a classified repetition directive "attests" subsequent matching
     * tool calls as human-directed (default: 300,000ms = 5 minutes, or until
     * the next user instruction). Attested calls are exempt from loop
     * heuristics but NOT from the stagnation ceiling or hard limits.
     */
    humanAttestationWindowMs?: number;
    /**
     * Maximum consecutive HUMAN-ATTESTED calls that return byte-identical
     * results before the breaker trips anyway (default: 12). This is the
     * "even if the user asked for it, this is now waste" backstop. When the
     * user stated an explicit count ("5 times"), the extracted count replaces
     * this ceiling for that attestation.
     */
    maxHumanAttestedStagnantSteps?: number;
    /**
     * Minimum classifier score for a user message to count as a repetition
     * directive (default 0.5 — one strong directive family passes; two partial
     * hints combine to pass).
     */
    intentDirectiveThreshold?: number;
    /**
     * Master switch for the "Allow Repeat Tool Calls If User Asks" behavior
     * (console: Agent Settings → User-Intent Attestation). Default: enabled
     * whenever recordUserInstruction / mid-run user messages are used. Set to
     * `false` for the strictest posture — user-directed repeats are then
     * treated like any other loop and trip the breaker.
     */
    enableUserIntentAttestation?: boolean;
    /**
     * When enabled (default), the breaker queues a WARNING for the model when
     * a pattern is one call away from tripping (repeat / no-progress). The
     * LangGraph / Vercel model wrappers inject it into the next model
     * invocation so the LLM can change strategy before the kill.
     */
    warnBeforeTrip?: boolean;
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
    /** Bounded checkpoint retention window (default 50 turns) */
    maxCheckpoints?: number;
    /**
     * Bounded tool-call ledger retention (default 500 entries). Enterprise runs
     * must not grow memory without limit; pruning keeps the newest entries and
     * every repeat/no-progress detection window (60s default) stays intact.
     */
    maxToolCallHistory?: number;
    /** Bounded prompt-history retention (default 200 entries) */
    maxPromptHistory?: number;
    /**
     * Automatically run the Ctrl+Z rewind engine (saga compensations + halt +
     * cooldown + receipt) when the circuit breaker kills this run.
     * Default: false — rewind stays operator-triggered unless opted in.
     */
    autoRewindOnKill?: boolean;
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
    /** OpenTelemetry export of breaker decisions + tool-call spans (see src/otel.ts). Auto-on when OTEL_EXPORTER_OTLP_ENDPOINT is set. */
    otel?: MovenOtelOptions;
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
    /** Flag: has the user prompt already been scanned by the prompt injection firewall */
    _userPromptScanned: boolean;
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
    /**
     * Per-run rolling hourly spend window (timestamp, cost) used by the
     * Overnight Burn Guard's velocity check. Scoped to THIS run — no
     * cross-run contamination from static shared state.
     */
    hourlySpendWindow: {
        timestamp: number;
        cost: number;
    }[];
    /**
     * Grace steps granted after an auto-fallback switch: loop-detection
     * heuristics (repeat / no-progress / semantic / layer2) are suppressed
     * for this many tool calls so the cheaper model gets a fair chance to
     * show progress. Hard limits (cost, depth, burn guard, firewall,
     * hallucination, SRE) stay active the whole time.
     */
    fallbackGraceSteps: number;
    /** Epoch ms until which tool calls are attested as human-directed. */
    humanAttestUntil: number;
    /**
     * The ACTIVE attestation produced by the instruction-intent classifier:
     * confidence, extracted repetition budget, and topic terms used to match
     * the directive to the tool calls it actually applies to.
     */
    private attestation?;
    /** Pre-trip warnings waiting to be injected into the next model call. */
    private pendingWarnings;
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
    /**
     * Single-flight kill guard: guarantees the kill side-effects (banner,
     * onKill callback, cooldown, kill event) run EXACTLY once even when
     * concurrent tool executions trip the breaker in the same tick.
     */
    private killInitiated;
    constructor(options?: MovenOptions);
    setUserRequest(request: string): void;
    setSystemPrompt(prompt: string): void;
    recordPrompt(content: string, role?: string): void;
    /**
     * Registers a human instruction through the instruction-intent classifier.
     * The message is classified (lexicon features → weighted score → budget
     * extraction → topic attribution); only affirmative repetition directives
     * open an attestation window, and the resulting profile determines WHICH
     * calls are attested and with what stagnation budget.
     */
    recordUserInstruction(instruction: string): void;
    private prunePrompts;
    /** The active attestation profile, or undefined when none/expired. */
    getActiveAttestation(): AttestationProfile | undefined;
    /**
     * Queues a pre-trip warning for the model. Deduplicated per
     * (heuristic, toolName, argsHash) within a 60s window so the same nudge is
     * never injected twice; bounded to the 5 most recent warnings.
     */
    pushWarning(w: Omit<MovenGuardWarning, 'id' | 'createdAt'>): void;
    /** Drains all pending warnings (for injection into the next model call). */
    drainWarnings(): MovenGuardWarning[];
    /** Warnings currently queued (non-destructive peek, for dashboards/tests). */
    peekWarnings(): MovenGuardWarning[];
    /**
     * Decides whether a specific tool call is covered by the active
     * attestation. A directive WITH topic terms ("poll the build") only
     * attests calls whose tool name/args match those terms; a general
     * directive ("do it again") attests the current call pattern as a whole.
     */
    isCallAttested(toolName: string, args: any): boolean;
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
    /**
     * Single-flight kill guard. Returns true exactly once per run — concurrent
     * trippers get false and must skip duplicate side effects (banner, onKill,
     * cooldown, kill event) while still throwing their own MovenKillError.
     */
    markKillInitiated(): boolean;
    /** True once any kill path has begun for this run (single-flight guard). */
    isKillInitiated(): boolean;
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
