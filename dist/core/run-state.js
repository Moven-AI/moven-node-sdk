"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MovenRunState = exports.DEFAULT_CHEAPER_MODEL_MAP = void 0;
const crypto_1 = __importDefault(require("crypto"));
const errors_1 = require("./errors");
const safe_json_1 = require("./safe-json");
const checkpoint_1 = require("./checkpoint");
const semantic_fingerprint_1 = require("./semantic-fingerprint");
const pricing_1 = require("./pricing");
const layer2_1 = require("./layer2");
exports.DEFAULT_CHEAPER_MODEL_MAP = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-haiku-20240307',
    google: 'gemini-2.5-flash-lite',
    groq: 'llama-3.1-8b-instant',
    mistral: 'mistral-small-latest',
    cohere: 'command-r',
    ollama: 'llama3:8b',
    bedrock: 'anthropic.claude-3-haiku-20240307-v1:0',
    'aws-bedrock': 'anthropic.claude-3-haiku-20240307-v1:0',
    azure: 'gpt-4o-mini',
    'azure-openai': 'gpt-4o-mini',
    openrouter: 'openai/gpt-4o-mini',
    'meta-llama': 'meta-llama/llama-3.1-8b-instruct',
    mistralai: 'mistralai/mistral-small-24b-instruct-2501',
    deepinfra: 'meta-llama/llama-3.1-8b-instruct',
    together: 'meta-llama/Llama-3-8b-chat-hf',
    fireworks: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    cerebras: 'llama3.1-8b',
    sambanova: 'Meta-Llama-3.1-8B-Instruct',
    // Model specific overrides
    'gpt-4o': 'gpt-4o-mini',
    'gpt-4-turbo': 'gpt-4o-mini',
    'gpt-4': 'gpt-4o-mini',
    'claude-3-5-sonnet-20240620': 'claude-3-haiku-20240307',
    'claude-3-opus-20240229': 'claude-3-haiku-20240307',
    'gemini-1.5-pro': 'gemini-2.5-flash-lite',
    'gemini-2.0-flash': 'gemini-2.5-flash-lite',
    // Enterprise direct providers
    'x-ai': 'grok-3-fast',
    xai: 'grok-3-fast',
    perplexity: 'sonar',
    deepseek: 'deepseek-chat',
    moonshot: 'moonshot-v1-8k',
    qwen: 'qwen-turbo',
    dashscope: 'qwen-turbo',
    zhipu: 'glm-4-flash',
    yi: 'yi-lightning',
    huggingface: 'Qwen/Qwen2.5-7B-Instruct',
    nvidia: 'meta/llama-3.1-8b-instruct',
    '01-ai': 'yi-lightning',
};
class MovenRunState {
    runId;
    agentId;
    agentName;
    framework;
    version;
    tags;
    startTime;
    toolCalls = [];
    depth = 0;
    cumulativePromptTokens = 0;
    cumulativeCompletionTokens = 0;
    cumulativeTotalTokens = 0;
    cumulativeCost = 0;
    stateHashes = [];
    isKilled = false;
    activeModel;
    isFallbackActive = false;
    cleanTurnsCount = 0;
    options;
    /** User request / prompt driving this run */
    userRequest = '';
    /** System prompt defining agent role and constraints */
    systemPrompt = '';
    /** Chronological history of prompt turns (user, assistant, tool, system) */
    prompts = [];
    /** Sliding window of the last N agent reasoning/thought strings */
    reasoningSteps = [];
    /** Parallel array of goal-state hashes computed after each tool result */
    intentHashes = [];
    /** Latest Progress Delta cosine similarity score (0–1). Updated on each evaluate(). */
    lastSemanticSimilarity = 0;
    /** SRE Telemetry: Sliding window of recent call statuses (true = success, false = error) */
    recentCallOutcomes = [];
    /** Consecutive structural schema validation failures counter */
    consecutiveSchemaFailures = 0;
    /** Max tokens generated in a single step (burst tracking) */
    lastStepTokenCount = 0;
    /** Global backoff epoch in ms */
    globalBackoffUntil = 0;
    /** Layer 2: Semantic Guard In-Process Instance */
    layer2Guard;
    /** Latest Layer 2 decision result */
    lastLayer2Result;
    // ─── IN-PROCESS ORCHESTRATION STATE (rewindable — Mechanism 1) ───────────
    /** Agent context / plan. Deep-copied into every checkpoint; restored on rewind. */
    context = {};
    /** Working scratchpad (intermediate values, partial results). Checkpointed + restored. */
    scratchpad = {};
    /** Per-tool retry counters. Checkpointed + restored on rewind. */
    retryCounts = {};
    // ─── HALT GATE + TOOL COOLDOWNS (post-rewind safety) ─────────────────────
    /** After a rewind the agent is halted — a human decision or re-plan is required. */
    halted = false;
    haltReason;
    /** Set when the operator forces a re-plan step instead of a blind resume. */
    replanRequested = false;
    /** toolName (or toolName:argsHash) → cooldown expiry epoch ms */
    toolCooldowns = new Map();
    /** Compensating-action registry (saga) — used by the rewind engine */
    compensations = new checkpoint_1.MovenCompensationRegistry();
    /** Ctrl+Z checkpoint ledger (bounded retention) */
    checkpointManager;
    constructor(options = {}) {
        this.options = {
            maxRepeatCalls: 5,
            repeatTimeWindowMs: 60000,
            maxCostDollar: 2.00,
            maxDepth: 15,
            maxNoProgressTurns: 3,
            judgeModel: options.judgeModel || 'google/gemini-2.5-flash-lite',
            autoFallbackCheaperModel: options.autoFallbackCheaperModel ?? true,
            enableLlmJudgeArbitrator: options.enableLlmJudgeArbitrator ?? true,
            maxErrorRatePct: options.maxErrorRatePct ?? 50.00,
            maxSlowCallLatencyMs: options.maxSlowCallLatencyMs ?? 30000,
            maxSlowCallRatePct: options.maxSlowCallRatePct ?? 40.00,
            maxSchemaValidationFailures: options.maxSchemaValidationFailures ?? 3,
            maxTokensPerStep: options.maxTokensPerStep ?? 8192,
            enableStructuralValidation: options.enableStructuralValidation ?? true,
            enableGlobalBackoff: options.enableGlobalBackoff ?? true,
            slidingWindowRequests: options.slidingWindowRequests ?? 20,
            agentName: 'agent-run',
            ...options,
        };
        this.runId = options.runId || `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        // Strict lowercase kebab-case slug format
        const rawSlug = (this.options.agentId || this.options.agentName || 'default-agent')
            .toLowerCase()
            .trim()
            .replace(/\s+/g, '-')
            .replace(/_/g, '-')
            .replace(/[^a-z0-9-]/g, '');
        this.agentId = rawSlug || 'default-agent';
        this.agentName = this.options.agentName || this.agentId;
        this.framework = this.options.framework || 'Custom Agent Wrapper';
        this.version = this.options.version || '1.0.0';
        this.tags = this.options.tags || ['production'];
        this.startTime = Date.now();
        this.activeModel = this.options.model || this.options.currentModel || 'openai/gpt-4o-mini';
        // Initialize Layer 2 Semantic Guard
        this.layer2Guard = new layer2_1.MovenLayer2Guard(this.agentId, this.options.layer2);
        // Bounded checkpoint ledger + compensation registry (saga pattern)
        this.checkpointManager = new checkpoint_1.MovenCheckpointManager(this.options.maxCheckpoints ?? 50);
        if (options.compensations) {
            for (const [toolName, comp] of Object.entries(options.compensations)) {
                this.compensations.register(toolName, comp);
            }
        }
        // Always trigger dynamic live pricing engine refresh
        pricing_1.MovenDynamicPricingEngine.refreshLivePricing();
        const req = options.userRequest || options.goal || options.metadata?.user_request || options.metadata?.userRequest;
        if (req) {
            this.userRequest = req;
            this.layer2Guard.memory.setGoal(this.userRequest);
        }
        if (options.metadata?.system_prompt || options.metadata?.systemPrompt) {
            this.systemPrompt = options.metadata.system_prompt || options.metadata.systemPrompt;
        }
    }
    setUserRequest(request) {
        this.userRequest = request;
        this.recordPrompt(request, 'user');
    }
    setSystemPrompt(prompt) {
        this.systemPrompt = prompt;
        this.recordPrompt(prompt, 'system');
    }
    recordPrompt(content, role = 'user') {
        this.prompts.push({ role, content, timestamp: Date.now() });
    }
    getModel() {
        return this.activeModel;
    }
    getActiveModel() {
        return this.activeModel;
    }
    switchToCheaperModel() {
        const cheaper = this.getCheaperModel();
        this.activeModel = cheaper;
        this.isFallbackActive = true;
        this.cleanTurnsCount = 0;
        return cheaper;
    }
    registerCleanTurn() {
        if (!this.isFallbackActive)
            return false;
        this.cleanTurnsCount += 1;
        // If agent makes 3 consecutive clean turns under fallback, restore primary model!
        if (this.cleanTurnsCount >= 3) {
            this.activeModel = this.options.currentModel || 'openai/gpt-4o-mini';
            this.isFallbackActive = false;
            this.cleanTurnsCount = 0;
            return true; // Model restored!
        }
        return false;
    }
    updateOptions(newRules) {
        if (newRules.maxRepeatCalls !== undefined)
            this.options.maxRepeatCalls = newRules.maxRepeatCalls;
        if (newRules.maxCostDollar !== undefined)
            this.options.maxCostDollar = newRules.maxCostDollar;
        if (newRules.maxDepth !== undefined)
            this.options.maxDepth = newRules.maxDepth;
        if (newRules.maxNoProgressTurns !== undefined)
            this.options.maxNoProgressTurns = newRules.maxNoProgressTurns;
        if (newRules.cheaperModel !== undefined)
            this.options.cheaperModel = newRules.cheaperModel;
        if (newRules.autoFallbackCheaperModel !== undefined)
            this.options.autoFallbackCheaperModel = newRules.autoFallbackCheaperModel;
        if (newRules.enableLlmJudgeArbitrator !== undefined)
            this.options.enableLlmJudgeArbitrator = newRules.enableLlmJudgeArbitrator;
        if (newRules.enableSemanticCache !== undefined)
            this.options.enableSemanticCache = newRules.enableSemanticCache;
        if (newRules.semanticCache !== undefined)
            this.options.semanticCache = { ...this.options.semanticCache, ...newRules.semanticCache };
        if (newRules.semanticFingerprint !== undefined)
            this.options.semanticFingerprint = { ...this.options.semanticFingerprint, ...newRules.semanticFingerprint };
        if (newRules.maxErrorRatePct !== undefined)
            this.options.maxErrorRatePct = newRules.maxErrorRatePct;
        if (newRules.maxSlowCallLatencyMs !== undefined)
            this.options.maxSlowCallLatencyMs = newRules.maxSlowCallLatencyMs;
        if (newRules.maxSlowCallRatePct !== undefined)
            this.options.maxSlowCallRatePct = newRules.maxSlowCallRatePct;
        if (newRules.maxSchemaValidationFailures !== undefined)
            this.options.maxSchemaValidationFailures = newRules.maxSchemaValidationFailures;
        if (newRules.maxTokensPerStep !== undefined)
            this.options.maxTokensPerStep = newRules.maxTokensPerStep;
        if (newRules.enableStructuralValidation !== undefined)
            this.options.enableStructuralValidation = newRules.enableStructuralValidation;
        if (newRules.enableGlobalBackoff !== undefined)
            this.options.enableGlobalBackoff = newRules.enableGlobalBackoff;
        if (newRules.slidingWindowRequests !== undefined)
            this.options.slidingWindowRequests = newRules.slidingWindowRequests;
        if (newRules.safeToRetryTools !== undefined)
            this.options.safeToRetryTools = newRules.safeToRetryTools;
        if (newRules.pollingTtlSeconds !== undefined)
            this.options.pollingTtlSeconds = newRules.pollingTtlSeconds;
        if (newRules.readOnlyTools !== undefined)
            this.options.readOnlyTools = newRules.readOnlyTools;
        if (newRules.dryRun !== undefined)
            this.options.dryRun = newRules.dryRun;
        if (newRules.pauseOnTrip !== undefined)
            this.options.pauseOnTrip = newRules.pauseOnTrip;
        if (newRules.percentileStepBaseline !== undefined)
            this.options.percentileStepBaseline = newRules.percentileStepBaseline;
        if (newRules.promptFirewall !== undefined)
            this.options.promptFirewall = { ...this.options.promptFirewall, ...newRules.promptFirewall };
        if (newRules.layer2 !== undefined)
            this.options.layer2 = { ...this.options.layer2, ...newRules.layer2 };
    }
    getCheaperModel(providerOrModel) {
        // 1. If user explicitly set cheaperModel, always use that
        if (this.options.cheaperModel) {
            return this.options.cheaperModel;
        }
        const customMap = this.options.cheaperModelMap || {};
        const routingLayer = (this.options.provider || '').toLowerCase();
        // 2. Derive the author/family from (in priority order):
        //    a) explicit modelAuthor  b) explicit provider  c) parse from currentModel slug
        let author = (this.options.modelAuthor || '').toLowerCase();
        if (!author && routingLayer && routingLayer !== 'openrouter') {
            author = routingLayer; // e.g. 'openai', 'anthropic', 'google'
        }
        if (!author && this.options.currentModel && this.options.currentModel.includes('/')) {
            // e.g. "openai/gpt-4o" → "openai",  "meta-llama/llama-3-70b" → "meta-llama"
            author = this.options.currentModel.split('/')[0].toLowerCase();
        }
        // 3. Also try a direct model-level lookup (e.g. 'gpt-4o' → 'gpt-4o-mini')
        const bareCurrentModel = (this.options.currentModel || '').includes('/')
            ? this.options.currentModel.split('/').slice(1).join('/')
            : (this.options.currentModel || '');
        // 4. Resolution order: customMap[author] → customMap[bareModel] → DEFAULT[author] → DEFAULT[bareModel]
        let cheaperBare = (author && customMap[author]) ||
            (bareCurrentModel && customMap[bareCurrentModel]) ||
            (author && exports.DEFAULT_CHEAPER_MODEL_MAP[author]) ||
            (bareCurrentModel && exports.DEFAULT_CHEAPER_MODEL_MAP[bareCurrentModel]) ||
            '';
        // 5. Build the final model ID based on the routing layer
        if (routingLayer === 'openrouter') {
            // OpenRouter needs full "author/model" slugs
            if (cheaperBare) {
                // If cheaperBare already contains a slash it's already namespaced
                return cheaperBare.includes('/') ? cheaperBare : `${author}/${cheaperBare}`;
            }
            // Fallback to judge model on OpenRouter
            return this.options.judgeModel || 'google/gemini-2.5-flash-lite';
        }
        // 6. Native provider SDK (openai, anthropic, google, groq, mistral, cohere…)
        //    needs BARE model IDs — strip any "author/" prefix
        if (cheaperBare) {
            return cheaperBare.includes('/') ? cheaperBare.split('/').slice(1).join('/') : cheaperBare;
        }
        // 7. Last resort: use the provider's default cheaper model or judge model
        const providerFallback = author && exports.DEFAULT_CHEAPER_MODEL_MAP[author];
        if (providerFallback) {
            return providerFallback.includes('/') ? providerFallback.split('/').slice(1).join('/') : providerFallback;
        }
        // Absolute fallback
        return this.options.judgeModel || 'google/gemini-2.5-flash-lite';
    }
    isSafeToRetryTool(toolName) {
        const list = this.options.safeToRetryTools || [
            'check_build_status', 'poll_task', 'get_job_status', 'wait_for_lock',
            'check_status', 'poll_status', 'get_task_status', 'wait_for_job', 'poll'
        ];
        return list.some(item => toolName.toLowerCase().includes(item.toLowerCase()));
    }
    isReadOnlyTool(toolName) {
        const defaultReadOnlyPrefixes = ['get_', 'fetch_', 'read_', 'list_', 'search_', 'query_', 'check_', 'describe_', 'inspect_', 'poll_'];
        const customList = this.options.readOnlyTools || [];
        const lower = toolName.toLowerCase();
        return customList.includes(toolName) || defaultReadOnlyPrefixes.some(prefix => lower.startsWith(prefix));
    }
    /**
     * The interception point. Called BEFORE the real tool body runs — checks
     * the halt gate and cooldowns synchronously so a blocked call can never
     * reach the network (zero-proxy, in-process interception).
     * Throws MovenKillError when the call must not execute.
     */
    interceptionGuard(toolName, argsHash) {
        if (this.isKilled) {
            throw new errors_1.MovenKillError({
                runId: this.runId,
                heuristic: 'repeat_tool_call',
                reason: 'Execution blocked: circuit breaker already tripped for this run.',
                toolName,
                metrics: this.getMetrics(),
            });
        }
        if (this.halted) {
            throw new errors_1.MovenKillError({
                runId: this.runId,
                heuristic: 'repeat_tool_call',
                reason: `Execution blocked: agent is HALTED after a rewind. ${this.haltReason || 'A human decision or re-plan is required before resume.'}`,
                toolName,
                metrics: this.getMetrics(),
            });
        }
        if (this.isToolOnCooldown(toolName, argsHash)) {
            const remaining = Math.ceil(this.cooldownRemainingMs(toolName) / 1000);
            throw new errors_1.MovenKillError({
                runId: this.runId,
                heuristic: 'repeat_tool_call',
                reason: `Execution blocked: tool '${toolName}' is on post-rewind cooldown (${remaining}s remaining). It cannot retrigger the identical loop until the cooldown expires or an operator clears it.`,
                toolName,
                metrics: this.getMetrics(),
            });
        }
    }
    recordToolCall(toolName, args) {
        const argsHash = this.hashArguments(toolName, args);
        // In-process interception BEFORE anything can leave the process
        this.interceptionGuard(toolName, argsHash);
        // Saga: idempotency key — generate if absent and inject into args so the
        // downstream API can dedupe a post-rewind retry of the same logical call.
        const autoInject = this.options.autoInjectIdempotencyKey !== false;
        let idempotencyKey = args?.idempotency_key || args?.idempotencyKey || args?.idempotency_token || args?.client_request_token;
        if (!idempotencyKey && autoInject) {
            idempotencyKey = `mvn_${this.runId}_${toolName}_${this.depth + 1}_${argsHash}`.substring(0, 72);
            if (args && typeof args === 'object' && !Array.isArray(args) && !Object.isFrozen(args)) {
                try {
                    args.idempotency_key = idempotencyKey;
                }
                catch {
                    /* frozen/sealed args — key still recorded on the log */
                }
            }
        }
        idempotencyKey = typeof idempotencyKey === 'string' ? idempotencyKey : undefined;
        const isPollingTool = this.isSafeToRetryTool(toolName);
        const isReadOnly = this.isReadOnlyTool(toolName);
        this.depth += 1;
        // 1. Calculate actual / estimated tokens for this step
        const promptTokens = Math.max(pricing_1.MovenDynamicPricingEngine.estimateTokens(args) +
            pricing_1.MovenDynamicPricingEngine.estimateTokens(toolName) +
            Math.round(pricing_1.MovenDynamicPricingEngine.estimateTokens(this.systemPrompt) * 0.2) +
            Math.round(pricing_1.MovenDynamicPricingEngine.estimateTokens(this.userRequest) * 0.3), 50);
        const completionTokens = 150; // Initial token allocation for tool execution dispatch
        // 2. Dynamically calculate exact per-token step cost
        const costData = pricing_1.MovenDynamicPricingEngine.calculateStepTokenCost({
            promptTokens,
            completionTokens,
            modelName: this.activeModel,
            customPromptRatePerMillion: this.options.promptCostPerMillion,
            customCompletionRatePerMillion: this.options.completionCostPerMillion,
        });
        const log = {
            toolName,
            args,
            argsHash,
            timestamp: Date.now(),
            idempotencyKey,
            status: 'in_flight',
            depth: this.depth,
            isPollingTool,
            isReadOnly,
            promptTokens,
            completionTokens,
            tokens: costData.totalTokens,
            cost: costData.stepCost,
        };
        this.toolCalls.push(log);
        this.cumulativePromptTokens += promptTokens;
        this.cumulativeCompletionTokens += completionTokens;
        this.cumulativeTotalTokens += costData.totalTokens;
        this.cumulativeCost += costData.stepCost;
        // Snapshot Ctrl+Z step checkpoint — immutable deep copy of the FULL
        // in-process orchestration state (context, scratchpad, retry counters,
        // conversation history) taken BEFORE this call can touch the outside world.
        // NOTE: created with stepIndex === this.depth === log.depth — the checkpoint
        // captures the state immediately BEFORE the call at the same depth executes.
        this.checkpointManager.createCheckpoint(this.runId, this.agentId, this.depth, toolName, args, this.cumulativeCost, this.prompts.slice(-50), { toolArgs: args, reasoning: this.reasoningSteps[this.reasoningSteps.length - 1] }, this.systemPrompt, this.userRequest || (typeof args?.prompt === 'string' ? args.prompt : undefined), this.activeModel, `Step ${this.depth}: ${toolName}`, {
            context: this.context,
            scratchpad: this.scratchpad,
            retryCounts: this.retryCounts,
            turnNumber: this.depth,
        });
        return log;
    }
    /** Registers a call as queued (scheduled but not started). Not checkpointed, not costed. */
    queueToolCall(toolName, args) {
        const argsHash = this.hashArguments(toolName, args);
        const log = {
            toolName,
            args,
            argsHash,
            timestamp: Date.now(),
            status: 'queued',
            depth: this.depth + 1,
            isPollingTool: this.isSafeToRetryTool(toolName),
            isReadOnly: this.isReadOnlyTool(toolName),
        };
        this.toolCalls.push(log);
        return log;
    }
    /** All calls that have been dispatched but have not committed (or been cancelled). */
    pendingCalls() {
        return this.toolCalls.filter(c => c.status === 'queued' || c.status === 'in_flight');
    }
    /** Cancels every queued / in-flight call. Returns the cancelled logs. */
    cancelPending() {
        const cancelled = [];
        for (const c of this.toolCalls) {
            if (c.status === 'queued' || c.status === 'in_flight') {
                c.status = 'cancelled';
                cancelled.push(c);
            }
        }
        return cancelled;
    }
    recordToolResult(logOrResult, result, durationMs) {
        let log;
        let res;
        if (result !== undefined || (logOrResult && typeof logOrResult === 'object' && 'toolName' in logOrResult && 'argsHash' in logOrResult)) {
            log = logOrResult;
            res = result;
        }
        else {
            log = this.toolCalls[this.toolCalls.length - 1];
            res = logOrResult;
        }
        if (log) {
            log.result = res;
            log.durationMs = durationMs || (Date.now() - log.timestamp);
            // The call reached the downstream API and returned — it is committed.
            log.status = 'committed';
            log.committed = true;
            // Compute and attach Result-Delta Hash (status / payload progression)
            const resultHash = this.hashResultState(res);
            log.resultHash = resultHash;
            // SRE Outcome Tracking
            const latency = log.durationMs;
            const isError = res instanceof Error || (res && typeof res === 'object' && ('error' in res || res.status === 'error' || res.status === 'failed'));
            this.recordCallOutcome(!isError, latency, false);
            // Check if previous identical tool call had a different result (progressive external state)
            const prevIdentical = this.toolCalls
                .slice(0, -1)
                .reverse()
                .find(c => c.toolName === log.toolName && c.argsHash === log.argsHash);
            if (prevIdentical && prevIdentical.resultHash && prevIdentical.resultHash !== resultHash) {
                log.isResultProgressive = true;
            }
            // Hash turn state for no-progress heuristic
            const turnHash = this.hashStateTurn(log.toolName, res);
            this.stateHashes.push(turnHash);
            // Compute and store the goal-state hash (intent + result) for Semantic Fingerprint
            const intentText = log.reasoning || log.toolName;
            const intentHash = semantic_fingerprint_1.SemanticFingerprintEngine.computeIntentHash(intentText, res);
            log.intentHash = intentHash;
            // Maintain the sliding window (max 10 entries)
            const MAX_WINDOW = 10;
            this.intentHashes.push(intentHash);
            if (this.intentHashes.length > MAX_WINDOW)
                this.intentHashes.shift();
            // Layer 2: Asynchronously extract facts and pre-embed into memory
            if (this.layer2Guard && this.options.layer2?.enabled !== false) {
                this.layer2Guard.recordToolResult(log.toolName, log.args || {}, res);
            }
        }
    }
    // ─── ORCHESTRATION STATE MUTATORS (all rewindable) ──────────────────────
    updateContext(patch) {
        this.context = { ...this.context, ...patch };
    }
    updateScratchpad(patch) {
        this.scratchpad = { ...this.scratchpad, ...patch };
    }
    incrementRetry(toolName) {
        this.retryCounts[toolName] = (this.retryCounts[toolName] || 0) + 1;
        return this.retryCounts[toolName];
    }
    /** Register a compensating action (saga inverse) for a tool. */
    registerCompensation(toolName, input) {
        this.compensations.register(toolName, input);
    }
    // ─── HALT GATE + COOLDOWNS ───────────────────────────────────────────────
    /**
     * Puts a tool on cooldown. Returns the cooldown expiry (epoch ms).
     * With argsHash the cooldown targets the identical call; without it the
     * whole tool is blocked — safer for incident response.
     */
    applyCooldown(toolName, seconds = this.options.rewindCooldownSeconds ?? 300, argsHash) {
        if (!toolName)
            return 0;
        const until = Date.now() + seconds * 1000;
        this.toolCooldowns.set(argsHash ? `${toolName}:${argsHash}` : toolName, until);
        return until;
    }
    isToolOnCooldown(toolName, argsHash) {
        const now = Date.now();
        const exact = argsHash ? this.toolCooldowns.get(`${toolName}:${argsHash}`) : undefined;
        const toolWide = this.toolCooldowns.get(toolName);
        if (exact !== undefined && exact > now)
            return true;
        if (toolWide !== undefined && toolWide > now)
            return true;
        return false;
    }
    cooldownRemainingMs(toolName) {
        const now = Date.now();
        let max = 0;
        for (const [key, until] of this.toolCooldowns.entries()) {
            if (until <= now) {
                this.toolCooldowns.delete(key);
                continue;
            }
            if (!toolName || key === toolName || key.startsWith(`${toolName}:`)) {
                max = Math.max(max, until - now);
            }
        }
        return max;
    }
    clearCooldowns() {
        this.toolCooldowns.clear();
    }
    /**
     * Mechanism 1 rewind: pointer restoration of in-process orchestration state.
     * External side effects are NOT touched here — the rewind engine handles
     * sagas/manual-review for committed calls before invoking this.
     * Returns the number of truncated (forgotten) tool-call log entries.
     */
    restoreFromCheckpoint(ckpt) {
        this.context = ckpt.context ? { ...ckpt.context } : {};
        this.scratchpad = ckpt.scratchpad ? { ...ckpt.scratchpad } : {};
        this.retryCounts = ckpt.retryCounts ? { ...ckpt.retryCounts } : {};
        if (ckpt.messagesSnapshot) {
            this.prompts = ckpt.messagesSnapshot.map(p => ({ ...p }));
        }
        if (ckpt.model)
            this.activeModel = ckpt.model;
        this.cumulativeCost = ckpt.cumulativeCost || 0;
        this.depth = ckpt.stepIndex - 1 < 0 ? 0 : ckpt.stepIndex - 1;
        // Keep only calls strictly BEFORE the checkpoint's step (checkpoint S is
        // captured before call S runs, so call S and everything after is undone).
        const keepCount = this.toolCalls.filter(c => (c.depth !== undefined ? c.depth < ckpt.stepIndex : c.timestamp <= ckpt.timestamp)).length;
        const truncated = this.toolCalls.length - keepCount;
        this.toolCalls = this.toolCalls.slice(0, keepCount);
        // Reset inference-window state to post-restore baseline
        this.stateHashes = [];
        this.intentHashes = [];
        this.reasoningSteps = [];
        this.consecutiveSchemaFailures = 0;
        this.lastLayer2Result = undefined;
        this.replanRequested = false;
        return truncated;
    }
    recordCallOutcome(success, latencyMs = 0, isSchemaFailure = false) {
        const MAX_WINDOW = this.options.slidingWindowRequests || 20;
        this.recentCallOutcomes.push({ timestamp: Date.now(), success, latencyMs, isSchemaFailure });
        if (this.recentCallOutcomes.length > MAX_WINDOW)
            this.recentCallOutcomes.shift();
        if (isSchemaFailure) {
            this.consecutiveSchemaFailures += 1;
        }
        else if (success) {
            this.consecutiveSchemaFailures = 0;
        }
    }
    recordSchemaValidationFailure(toolName, errorMsg) {
        this.recordCallOutcome(false, 0, true);
    }
    recordStepTokens(promptTokens, completionTokens = 0) {
        const total = promptTokens + completionTokens;
        this.lastStepTokenCount = total;
        this.cumulativePromptTokens += promptTokens;
        this.cumulativeCompletionTokens += completionTokens;
        this.cumulativeTotalTokens += total;
        const costData = pricing_1.MovenDynamicPricingEngine.calculateStepTokenCost({
            promptTokens,
            completionTokens,
            modelName: this.activeModel,
            customPromptRatePerMillion: this.options.promptCostPerMillion,
            customCompletionRatePerMillion: this.options.completionCostPerMillion,
        });
        this.cumulativeCost += costData.stepCost;
    }
    getRecentErrorRate() {
        if (this.recentCallOutcomes.length === 0)
            return 0;
        const errors = this.recentCallOutcomes.filter(o => !o.success).length;
        return (errors / this.recentCallOutcomes.length) * 100;
    }
    getRecentSlowCallRate(thresholdMs) {
        const thresh = thresholdMs || this.options.maxSlowCallLatencyMs || 30000;
        if (this.recentCallOutcomes.length === 0)
            return 0;
        const slow = this.recentCallOutcomes.filter(o => o.latencyMs > thresh).length;
        return (slow / this.recentCallOutcomes.length) * 100;
    }
    setGlobalBackoff(durationMs) {
        this.globalBackoffUntil = Date.now() + durationMs;
    }
    /**
     * Record the agent's reasoning/thought text for the current step.
     * Call this after receiving the LLM response, before calling recordToolCall.
     * Compatible with: Claude <thinking>, OpenAI o-series reasoning, LangChain thought fields.
     */
    recordReasoning(step) {
        if (!step || step.trim().length === 0)
            return;
        const MAX_WINDOW = 10;
        this.reasoningSteps.push(step.trim());
        if (this.reasoningSteps.length > MAX_WINDOW)
            this.reasoningSteps.shift();
        // Tag the most recent tool call with this reasoning text (if available)
        if (this.toolCalls.length > 0) {
            const last = this.toolCalls[this.toolCalls.length - 1];
            if (!last.reasoning)
                last.reasoning = step.trim();
        }
    }
    /**
     * Returns true if the given tool name is declared as high-risk by the user,
     * meaning the async LLM Judge must confirm progress before it executes.
     */
    isHighRiskTool(toolName) {
        return (this.options.highRiskTools ?? []).includes(toolName);
    }
    addCost(cost) {
        this.cumulativeCost += cost;
    }
    getMetrics() {
        const rates = pricing_1.MovenDynamicPricingEngine.getModelRates(this.activeModel);
        const promptRate = this.options.promptCostPerMillion ?? rates.promptPerMillion;
        const compRate = this.options.completionCostPerMillion ?? rates.completionPerMillion;
        const savings = pricing_1.MovenDynamicPricingEngine.calculateMoneySaved({
            modelName: this.activeModel,
            totalToolCallsMade: this.toolCalls.length,
            actualCostSpent: this.cumulativeCost,
            actualPromptTokensSpent: this.cumulativePromptTokens,
            actualCompletionTokensSpent: this.cumulativeCompletionTokens,
            customPromptRatePerMillion: promptRate,
            customCompletionRatePerMillion: compRate,
        });
        return {
            totalCost: Number(this.cumulativeCost.toFixed(4)),
            totalToolCalls: this.toolCalls.length,
            repeatCallsCount: this.getRecentRepeatCallsCount(),
            depth: this.depth,
            durationMs: Date.now() - this.startTime,
            totalTokens: this.cumulativeTotalTokens,
            promptTokens: this.cumulativePromptTokens,
            completionTokens: this.cumulativeCompletionTokens,
            costPerPromptToken: promptRate / 1_000_000,
            costPerCompletionToken: compRate / 1_000_000,
            moneySaved: savings.moneySaved,
            preventedTokens: savings.totalPreventedTokens,
        };
    }
    /**
     * Calculates recent repeat calls with Result-Delta Hashing and Polling Whitelisting.
     * - If output state is progressing (status changes from pending -> building -> done), repeat count resets.
     * - If tool is safe-to-retry / polling, it is allowed up to pollingTtlSeconds (default 600s).
     * - If tool is read-only, threshold receives relaxed headroom.
     */
    getRecentRepeatCallsCount(timeWindowMs) {
        const window = timeWindowMs || this.options.repeatTimeWindowMs || 60000;
        if (this.toolCalls.length === 0)
            return 0;
        const lastCall = this.toolCalls[this.toolCalls.length - 1];
        const now = Date.now();
        // 1. Check Safe-to-Retry / Long-Running Polling Tools
        if (lastCall.isPollingTool) {
            const pollingCalls = this.toolCalls.filter(c => c.toolName === lastCall.toolName && c.argsHash === lastCall.argsHash);
            if (pollingCalls.length > 1) {
                const firstPollTime = pollingCalls[0].timestamp;
                const totalPollDurationSec = (now - firstPollTime) / 1000;
                const ttlSec = this.options.pollingTtlSeconds || 600; // 10 minutes default
                if (totalPollDurationSec > ttlSec) {
                    // Polling TTL exceeded — trip breaker
                    return this.options.maxRepeatCalls ? this.options.maxRepeatCalls + 1 : 10;
                }
                // If results are actively changing or within TTL, do NOT treat as stagnant loop!
                const hasProgressiveResults = pollingCalls.some(c => c.isResultProgressive);
                if (hasProgressiveResults || totalPollDurationSec <= ttlSec) {
                    return 1; // Valid non-stagnant polling
                }
            }
        }
        // 2. Result-Delta Hashing: Distinguish stagnant loop from evolving result state
        const enableResultDelta = this.options.enableResultDeltaProgression !== false;
        const identicalArgsCalls = this.toolCalls.filter(call => call.argsHash === lastCall.argsHash && (now - call.timestamp) <= window);
        if (enableResultDelta && identicalArgsCalls.length > 1) {
            // Find the last consecutive run of stagnant results (where both argsHash AND resultHash are identical)
            const currentResultHash = lastCall.resultHash;
            let stagnantCount = 0;
            for (let i = identicalArgsCalls.length - 1; i >= 0; i--) {
                const call = identicalArgsCalls[i];
                if (call.resultHash === currentResultHash) {
                    stagnantCount++;
                }
                else {
                    // Result differed in previous turn! External state changed. Break consecutive stagnant chain.
                    break;
                }
            }
            return stagnantCount;
        }
        return identicalArgsCalls.length;
    }
    canonicalStringify(obj) {
        if (obj === null || typeof obj !== 'object') {
            // BigInt/functions/circular leaves must not throw the hot path
            return (0, safe_json_1.safeStringify)(obj);
        }
        if (Array.isArray(obj)) {
            return '[' + obj.map(item => this.canonicalStringify(item)).join(',') + ']';
        }
        const keys = Object.keys(obj).sort();
        const keyPairs = keys.map(key => `${JSON.stringify(key)}:${this.canonicalStringify(obj[key])}`);
        return '{' + keyPairs.join(',') + '}';
    }
    hashArguments(toolName, args) {
        try {
            const canonical = this.canonicalStringify({ toolName, args: args || {} });
            return crypto_1.default.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
        }
        catch {
            // DETERMINISTIC fallback — a unique-per-call value here would silently
            // disable repeat detection and make idempotency keys retry-unique.
            const canonical = (0, safe_json_1.stableHashInput)({ toolName, args: args || {} });
            return crypto_1.default.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
        }
    }
    hashResultState(result) {
        try {
            if (result === undefined || result === null)
                return 'null_result';
            // Extract status field if object contains it
            let statePayload = result;
            if (typeof result === 'object' && !Array.isArray(result)) {
                if ('status' in result || 'state' in result || 'progress' in result || 'data' in result || 'id' in result) {
                    statePayload = {
                        status: result.status ?? result.state ?? result.progress,
                        id: result.id,
                        keys: Object.keys(result).sort(),
                        length: Array.isArray(result.data) ? result.data.length : undefined,
                    };
                }
            }
            const canonical = this.canonicalStringify(statePayload);
            return crypto_1.default.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
        }
        catch {
            // Deterministic fallback keeps result-delta hashing stable across retries
            const canonical = (0, safe_json_1.stableHashInput)(result);
            return crypto_1.default.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
        }
    }
    hashStateTurn(toolName, result) {
        try {
            const canonical = this.canonicalStringify({ toolName, result });
            return crypto_1.default.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
        }
        catch {
            return `turn_${Date.now()}`;
        }
    }
    /**
     * Generates the complete ReactFlow / n8n workflow graph JSON representation
     * of this agent run, including triggers, agent node, model/memory/tool subnodes,
     * circuit breaker router, and outcome branches.
     */
    generateWorkflowGraph(options) {
        const isKilled = options?.isKilled ?? false;
        const model = this.getModel() || this.options.model || this.options.currentModel || this.options.judgeModel || 'deepseek/deepseek-chat';
        const provider = this.options.provider || 'openrouter';
        const checkpoints = this.checkpointManager.getCheckpoints();
        const lastCheckpoint = checkpoints[checkpoints.length - 1];
        const checkpointId = lastCheckpoint ? `ckpt_${lastCheckpoint.traceId}_step_${lastCheckpoint.stepIndex}` : 'chk_init';
        const checkpointTurn = lastCheckpoint ? lastCheckpoint.stepIndex : 1;
        // Unique Tool Names
        const uniqueTools = Array.from(new Set(this.toolCalls.map(tc => tc.toolName)));
        const primaryTool = uniqueTools[0] || 'search_customer_tickets';
        // Build Nodes
        const nodes = [
            {
                id: 'trigger',
                type: 'triggerNode',
                position: { x: 50, y: 120 },
                data: {
                    label: 'Chat Message Received',
                    latency: '2ms',
                    inputs: { user_request: this.userRequest || 'Autonomous agent execution turn' },
                    outputs: { session_id: this.runId, status: 'received' },
                },
            },
            {
                id: 'agent',
                type: 'agentNode',
                position: { x: 270, y: 110 },
                data: {
                    label: this.agentName,
                    framework: this.framework,
                    model: model,
                    provider: provider,
                    inputs: { agent: this.agentName, maxTurns: this.options.maxDepth || 15 },
                    outputs: { tool_count: this.toolCalls.length, status: isKilled ? 'intercepted' : 'completed' },
                },
            },
            {
                id: 'sub-model',
                type: 'subnode',
                position: { x: 190, y: 260 },
                data: {
                    category: 'Model',
                    label: model.split('/').pop() || model,
                    type: 'model',
                    inputs: { model: model, provider: provider },
                    outputs: { total_cost: this.cumulativeCost },
                },
            },
            {
                id: 'sub-memory',
                type: 'subnode',
                position: { x: 350, y: 260 },
                data: {
                    category: 'Memory',
                    label: 'State Checkpoint',
                    type: 'memory',
                    inputs: { checkpoint_id: checkpointId },
                    outputs: { turn: checkpointTurn, checkpoints_saved: checkpoints.length },
                },
            },
            {
                id: 'sub-tool-0',
                type: 'subnode',
                position: { x: 510, y: 260 },
                data: {
                    category: 'Tool Call',
                    label: primaryTool,
                    type: 'tool',
                    inputs: this.toolCalls[0]?.args || { ticket_id: 'TCK-88192' },
                    outputs: this.toolCalls[0]?.result || { status: 'PENDING_REVIEW' },
                },
            },
            {
                id: 'router',
                type: 'routerNode',
                position: { x: 550, y: 110 },
                data: {
                    label: 'Circuit Breaker',
                    inputs: { max_repeats: this.options.maxRepeatCalls || 3, observed_repeats: this.toolCalls.length },
                    outputs: { condition: isKilled ? 'false (tripped)' : 'true (healthy)' },
                },
            },
            {
                id: 'success',
                type: 'outcomeNode',
                position: { x: 770, y: 60 },
                data: {
                    label: 'Success',
                    sublabel: '200 OK Execution Completed',
                    status: 'success',
                    inputs: { status: '200 OK' },
                    outputs: { action: 'Transaction Committed' },
                },
            },
            {
                id: 'failure',
                type: 'outcomeNode',
                position: { x: 770, y: 170 },
                data: {
                    label: 'Loop Intercepted',
                    sublabel: isKilled ? '+$18.42 Protected' : 'State Rolled Back',
                    status: 'failure',
                    inputs: { reason: options?.errorReason || 'Circuit breaker threshold tripped' },
                    outputs: { action: 'State Rewound to Last Checkpoint' },
                },
            },
        ];
        // Edges
        const edges = [
            { id: 'e-trigger-agent', source: 'trigger', target: 'agent', type: 'smoothstep', style: { stroke: '#52525B', strokeWidth: 1.5 } },
            { id: 'e-agent-sub-model', source: 'agent', sourceHandle: 'subnodes', target: 'sub-model', type: 'smoothstep', style: { stroke: '#444444', strokeWidth: 1.5, strokeDasharray: '3,3' } },
            { id: 'e-agent-sub-memory', source: 'agent', sourceHandle: 'subnodes', target: 'sub-memory', type: 'smoothstep', style: { stroke: '#444444', strokeWidth: 1.5, strokeDasharray: '3,3' } },
            { id: 'e-agent-sub-tool', source: 'agent', sourceHandle: 'subnodes', target: 'sub-tool-0', type: 'smoothstep', style: { stroke: '#444444', strokeWidth: 1.5, strokeDasharray: '3,3' } },
            { id: 'e-agent-router', source: 'agent', sourceHandle: 'output', target: 'router', type: 'smoothstep', style: { stroke: '#52525B', strokeWidth: 1.5 } },
            { id: 'e-router-success', source: 'router', sourceHandle: 'true', target: 'success', type: 'smoothstep', style: { stroke: '#10B981', strokeWidth: 1.5 } },
            { id: 'e-router-failure', source: 'router', sourceHandle: 'false', target: 'failure', type: 'smoothstep', style: { stroke: '#EF4444', strokeWidth: 1.5 } },
        ];
        return {
            nodes,
            edges,
            viewport: { x: 0, y: 0, zoom: 1 },
            metadata: {
                agent_name: this.agentName,
                framework: this.framework,
                model: model,
                tool_count: this.toolCalls.length,
                duration_ms: Date.now() - this.startTime,
                is_killed: isKilled,
            },
        };
    }
}
exports.MovenRunState = MovenRunState;
