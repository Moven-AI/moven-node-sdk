import crypto from 'crypto';
import { MovenKillMetrics } from './errors';
import { BurnGuardOptions } from './burn-guard';
import { SemanticCacheOptions } from './semantic-cache';
import { MovenCheckpointManager } from './checkpoint';
import { SemanticFingerprintOptions, SemanticFingerprintEngine } from './semantic-fingerprint';
import { MovenDynamicPricingEngine } from './pricing';

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
  agentId?: string; // Unique agent identifier (e.g. 'agent_inventory_prod_01')
  agentName?: string; // Production agent name identifier
  userId?: string; // End-user / person identifier (e.g. 'user_88241', 'srini@company.com')
  userEmail?: string; // Optional user email
  metadata?: Record<string, any>; // Arbitrary custom metadata tags
  framework?: string; // Agent framework (e.g. 'LangGraph / LangChain', 'Vercel AI SDK')
  version?: string; // Agent version identifier
  tags?: string[]; // Environment or category tags
  allowedTools?: string[]; // Allowed tool names schema for hallucination detection
  maxRepeatCalls?: number; // default: 5
  repeatTimeWindowMs?: number; // default: 60000 (60s)
  maxCostDollar?: number; // default: 2.00
  maxDepth?: number; // default: 15
  maxNoProgressTurns?: number; // default: 3
  judgeModel?: string; // default: 'google/gemini-2.5-flash-lite'
  provider?: 'openai' | 'anthropic' | 'google' | 'cohere' | 'mistral' | 'groq' | 'openrouter' | string;
  modelAuthor?: string; // The model family author (e.g. 'openai' from 'openai/gpt-4o-mini')
  currentModel?: string; // The exact model ID the user's code is running
  cheaperModel?: string; // Explicit cheaper fallback model ID (e.g. 'google/gemini-2.5-flash-lite')
  cheaperModelMap?: Record<string, string>; // Mapping of provider/primary model -> cheaper model
  autoFallbackCheaperModel?: boolean; // default: true
  enableLlmJudgeArbitrator?: boolean; // default: true
  burnGuard?: BurnGuardOptions; // Overnight Burn Guard ($2000 loss prevention engine)
  semanticCache?: SemanticCacheOptions; // Semantic caching engine options
  semanticFingerprint?: SemanticFingerprintOptions; // Semantic Fingerprint loop detection layer

  // ─── NEW POLICIES: POLLING, IDEMPOTENCY, DRY RUN & ADAPTIVE SAFEGUARDS ───
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

  // ─── SRE TECHNICAL RELIABILITY & STRUCTURAL SCHEMA SAFEGUARDS ───
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
  endpoint?: string; // default: https://api.moven.dev/events
  onKill?: (error: any) => void;
  onPause?: (info: { agentName: string; reason: string; toolName?: string; args?: any; resumeToken: string }) => void;
  onHallucination?: (info: { agentName: string; reason: string; toolName?: string; args?: any }) => void;
  customCheck?: (state: MovenRunState) => { tripped: boolean; reason: string } | null;
}

export const DEFAULT_CHEAPER_MODEL_MAP: Record<string, string> = {
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
};

export class MovenRunState {
  public readonly runId: string;
  public readonly agentId: string;
  public readonly agentName: string;
  public readonly framework: string;
  public readonly version: string;
  public readonly tags: string[];
  public readonly startTime: number;
  public toolCalls: ToolCallLog[] = [];
  public depth: number = 0;
  public cumulativePromptTokens: number = 0;
  public cumulativeCompletionTokens: number = 0;
  public cumulativeTotalTokens: number = 0;
  public cumulativeCost: number = 0;
  public stateHashes: string[] = [];
  public isKilled: boolean = false;
  public activeModel: string;
  public isFallbackActive: boolean = false;
  public cleanTurnsCount: number = 0;
  public options: MovenOptions;

  /** User request / prompt driving this run */
  public userRequest: string = '';
  /** System prompt defining agent role and constraints */
  public systemPrompt: string = '';
  /** Chronological history of prompt turns (user, assistant, tool, system) */
  public prompts: { role: string; content: string; timestamp: number }[] = [];

  /** Sliding window of the last N agent reasoning/thought strings */
  public reasoningSteps: string[] = [];
  /** Parallel array of goal-state hashes computed after each tool result */
  public intentHashes: string[] = [];
  /** Latest Progress Delta cosine similarity score (0–1). Updated on each evaluate(). */
  public lastSemanticSimilarity: number = 0;

  /** SRE Telemetry: Sliding window of recent call statuses (true = success, false = error) */
  public recentCallOutcomes: { timestamp: number; success: boolean; latencyMs: number; isSchemaFailure?: boolean }[] = [];
  /** Consecutive structural schema validation failures counter */
  public consecutiveSchemaFailures: number = 0;
  /** Max tokens generated in a single step (burst tracking) */
  public lastStepTokenCount: number = 0;
  /** Global backoff epoch in ms */
  public globalBackoffUntil: number = 0;

  constructor(options: MovenOptions = {}) {
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
    this.agentName = this.options.agentName || 'default-agent';
    this.agentId = this.options.agentId || `agent_${this.agentName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    this.framework = this.options.framework || 'Custom Agent Wrapper';
    this.version = this.options.version || '1.0.0';
    this.tags = this.options.tags || ['production'];
    this.startTime = Date.now();
    this.activeModel = this.options.currentModel || 'openai/gpt-4o-mini';
    
    // Always trigger dynamic live pricing engine refresh
    MovenDynamicPricingEngine.refreshLivePricing();

    if (options.metadata?.user_request || options.metadata?.userRequest) {
      this.userRequest = options.metadata.user_request || options.metadata.userRequest;
    }
    if (options.metadata?.system_prompt || options.metadata?.systemPrompt) {
      this.systemPrompt = options.metadata.system_prompt || options.metadata.systemPrompt;
    }
  }

  public setUserRequest(request: string) {
    this.userRequest = request;
    this.recordPrompt(request, 'user');
  }

  public setSystemPrompt(prompt: string) {
    this.systemPrompt = prompt;
    this.recordPrompt(prompt, 'system');
  }

  public recordPrompt(content: string, role: string = 'user') {
    this.prompts.push({ role, content, timestamp: Date.now() });
  }

  public getModel(): string {
    return this.activeModel;
  }

  public getActiveModel(): string {
    return this.activeModel;
  }

  public switchToCheaperModel(): string {
    const cheaper = this.getCheaperModel();
    this.activeModel = cheaper;
    this.isFallbackActive = true;
    this.cleanTurnsCount = 0;
    return cheaper;
  }

  public registerCleanTurn(): boolean {
    if (!this.isFallbackActive) return false;
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

  public updateOptions(newRules: Partial<MovenOptions>) {
    if (newRules.maxRepeatCalls !== undefined) this.options.maxRepeatCalls = newRules.maxRepeatCalls;
    if (newRules.maxCostDollar !== undefined) this.options.maxCostDollar = newRules.maxCostDollar;
    if (newRules.maxDepth !== undefined) this.options.maxDepth = newRules.maxDepth;
    if (newRules.maxNoProgressTurns !== undefined) this.options.maxNoProgressTurns = newRules.maxNoProgressTurns;
    if (newRules.cheaperModel !== undefined) this.options.cheaperModel = newRules.cheaperModel;
    if (newRules.autoFallbackCheaperModel !== undefined) this.options.autoFallbackCheaperModel = newRules.autoFallbackCheaperModel;
    if (newRules.enableLlmJudgeArbitrator !== undefined) this.options.enableLlmJudgeArbitrator = newRules.enableLlmJudgeArbitrator;
  }

  public getCheaperModel(providerOrModel?: string): string {
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
      ? this.options.currentModel!.split('/').slice(1).join('/')
      : (this.options.currentModel || '');

    // 4. Resolution order: customMap[author] → customMap[bareModel] → DEFAULT[author] → DEFAULT[bareModel]
    let cheaperBare =
      (author && customMap[author]) ||
      (bareCurrentModel && customMap[bareCurrentModel]) ||
      (author && DEFAULT_CHEAPER_MODEL_MAP[author]) ||
      (bareCurrentModel && DEFAULT_CHEAPER_MODEL_MAP[bareCurrentModel]) ||
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
    const providerFallback = author && DEFAULT_CHEAPER_MODEL_MAP[author];
    if (providerFallback) {
      return providerFallback.includes('/') ? providerFallback.split('/').slice(1).join('/') : providerFallback;
    }

    // Absolute fallback
    return this.options.judgeModel || 'google/gemini-2.5-flash-lite';
  }

  public readonly checkpointManager = new MovenCheckpointManager();

  public isSafeToRetryTool(toolName: string): boolean {
    const list = this.options.safeToRetryTools || [
      'check_build_status', 'poll_task', 'get_job_status', 'wait_for_lock', 
      'check_status', 'poll_status', 'get_task_status', 'wait_for_job', 'poll'
    ];
    return list.some(item => toolName.toLowerCase().includes(item.toLowerCase()));
  }

  public isReadOnlyTool(toolName: string): boolean {
    const defaultReadOnlyPrefixes = ['get_', 'fetch_', 'read_', 'list_', 'search_', 'query_', 'check_', 'describe_', 'inspect_', 'poll_'];
    const customList = this.options.readOnlyTools || [];
    const lower = toolName.toLowerCase();
    return customList.includes(toolName) || defaultReadOnlyPrefixes.some(prefix => lower.startsWith(prefix));
  }

  public recordToolCall(toolName: string, args: any): ToolCallLog {
    const argsHash = this.hashArguments(toolName, args);
    const idempotencyKey = args?.idempotency_key || args?.idempotencyKey || args?.idempotency_token || args?.client_request_token;
    const isPollingTool = this.isSafeToRetryTool(toolName);
    const isReadOnly = this.isReadOnlyTool(toolName);

    const log: ToolCallLog = {
      toolName,
      args,
      argsHash,
      timestamp: Date.now(),
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
      isPollingTool,
      isReadOnly,
    };
    this.toolCalls.push(log);
    this.depth += 1;

    // 1. Calculate actual / estimated tokens for this step
    const promptTokens = Math.max(
      MovenDynamicPricingEngine.estimateTokens(args) +
        MovenDynamicPricingEngine.estimateTokens(toolName) +
        Math.round(MovenDynamicPricingEngine.estimateTokens(this.systemPrompt) * 0.2) +
        Math.round(MovenDynamicPricingEngine.estimateTokens(this.userRequest) * 0.3),
      50
    );
    const completionTokens = 150; // Initial token allocation for tool execution dispatch

    // 2. Dynamically calculate exact per-token step cost
    const costData = MovenDynamicPricingEngine.calculateStepTokenCost({
      promptTokens,
      completionTokens,
      modelName: this.activeModel,
      customPromptRatePerMillion: this.options.promptCostPerMillion,
      customCompletionRatePerMillion: this.options.completionCostPerMillion,
    });

    this.cumulativePromptTokens += promptTokens;
    this.cumulativeCompletionTokens += completionTokens;
    this.cumulativeTotalTokens += costData.totalTokens;
    this.cumulativeCost += costData.stepCost;

    // Snapshot Ctrl+Z step checkpoint with prompt & state context
    this.checkpointManager.createCheckpoint(
      this.runId,
      this.agentId,
      this.depth,
      toolName,
      args,
      this.cumulativeCost,
      undefined,
      { toolArgs: args, reasoning: this.reasoningSteps[this.reasoningSteps.length - 1] },
      this.systemPrompt,
      this.userRequest || (typeof args?.prompt === 'string' ? args.prompt : undefined),
      this.activeModel,
      `Step ${this.depth}: ${toolName}`
    );

    return log;
  }

  public recordToolResult(logOrResult: ToolCallLog | any, result?: any, durationMs?: number) {
    let log: ToolCallLog;
    let res: any;

    if (result !== undefined || (logOrResult && typeof logOrResult === 'object' && 'toolName' in logOrResult && 'argsHash' in logOrResult)) {
      log = logOrResult as ToolCallLog;
      res = result;
    } else {
      log = this.toolCalls[this.toolCalls.length - 1];
      res = logOrResult;
    }

    if (log) {
      log.result = res;
      log.durationMs = durationMs || (Date.now() - log.timestamp);

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
      const intentHash = SemanticFingerprintEngine.computeIntentHash(intentText, res);
      log.intentHash = intentHash;

      // Maintain the sliding window (max 10 entries)
      const MAX_WINDOW = 10;
      this.intentHashes.push(intentHash);
      if (this.intentHashes.length > MAX_WINDOW) this.intentHashes.shift();
    }
  }

  public recordCallOutcome(success: boolean, latencyMs: number = 0, isSchemaFailure: boolean = false): void {
    const MAX_WINDOW = this.options.slidingWindowRequests || 20;
    this.recentCallOutcomes.push({ timestamp: Date.now(), success, latencyMs, isSchemaFailure });
    if (this.recentCallOutcomes.length > MAX_WINDOW) this.recentCallOutcomes.shift();

    if (isSchemaFailure) {
      this.consecutiveSchemaFailures += 1;
    } else if (success) {
      this.consecutiveSchemaFailures = 0;
    }
  }

  public recordSchemaValidationFailure(toolName?: string, errorMsg?: string): void {
    this.recordCallOutcome(false, 0, true);
  }

  public recordStepTokens(promptTokens: number, completionTokens: number = 0): void {
    const total = promptTokens + completionTokens;
    this.lastStepTokenCount = total;
    this.cumulativePromptTokens += promptTokens;
    this.cumulativeCompletionTokens += completionTokens;
    this.cumulativeTotalTokens += total;

    const costData = MovenDynamicPricingEngine.calculateStepTokenCost({
      promptTokens,
      completionTokens,
      modelName: this.activeModel,
      customPromptRatePerMillion: this.options.promptCostPerMillion,
      customCompletionRatePerMillion: this.options.completionCostPerMillion,
    });
    this.cumulativeCost += costData.stepCost;
  }

  public getRecentErrorRate(): number {
    if (this.recentCallOutcomes.length === 0) return 0;
    const errors = this.recentCallOutcomes.filter(o => !o.success).length;
    return (errors / this.recentCallOutcomes.length) * 100;
  }

  public getRecentSlowCallRate(thresholdMs?: number): number {
    const thresh = thresholdMs || this.options.maxSlowCallLatencyMs || 30000;
    if (this.recentCallOutcomes.length === 0) return 0;
    const slow = this.recentCallOutcomes.filter(o => o.latencyMs > thresh).length;
    return (slow / this.recentCallOutcomes.length) * 100;
  }

  public setGlobalBackoff(durationMs: number): void {
    this.globalBackoffUntil = Date.now() + durationMs;
  }

  /**
   * Record the agent's reasoning/thought text for the current step.
   * Call this after receiving the LLM response, before calling recordToolCall.
   * Compatible with: Claude <thinking>, OpenAI o-series reasoning, LangChain thought fields.
   */
  public recordReasoning(step: string): void {
    if (!step || step.trim().length === 0) return;

    const MAX_WINDOW = 10;
    this.reasoningSteps.push(step.trim());
    if (this.reasoningSteps.length > MAX_WINDOW) this.reasoningSteps.shift();

    // Tag the most recent tool call with this reasoning text (if available)
    if (this.toolCalls.length > 0) {
      const last = this.toolCalls[this.toolCalls.length - 1];
      if (!last.reasoning) last.reasoning = step.trim();
    }
  }

  /**
   * Returns true if the given tool name is declared as high-risk by the user,
   * meaning the async LLM Judge must confirm progress before it executes.
   */
  public isHighRiskTool(toolName: string): boolean {
    return (this.options.highRiskTools ?? []).includes(toolName);
  }

  public addCost(cost: number) {
    this.cumulativeCost += cost;
  }

  public getMetrics(): MovenKillMetrics {
    const rates = MovenDynamicPricingEngine.getModelRates(this.activeModel);
    const promptRate = this.options.promptCostPerMillion ?? rates.promptPerMillion;
    const compRate = this.options.completionCostPerMillion ?? rates.completionPerMillion;

    const savings = MovenDynamicPricingEngine.calculateMoneySaved({
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
  public getRecentRepeatCallsCount(timeWindowMs?: number): number {
    const window = timeWindowMs || this.options.repeatTimeWindowMs || 60000;
    if (this.toolCalls.length === 0) return 0;
    
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
    
    const identicalArgsCalls = this.toolCalls.filter(call => 
      call.argsHash === lastCall.argsHash && (now - call.timestamp) <= window
    );

    if (enableResultDelta && identicalArgsCalls.length > 1) {
      // Find the last consecutive run of stagnant results (where both argsHash AND resultHash are identical)
      const currentResultHash = lastCall.resultHash;
      let stagnantCount = 0;
      for (let i = identicalArgsCalls.length - 1; i >= 0; i--) {
        const call = identicalArgsCalls[i];
        if (call.resultHash === currentResultHash) {
          stagnantCount++;
        } else {
          // Result differed in previous turn! External state changed. Break consecutive stagnant chain.
          break;
        }
      }
      return stagnantCount;
    }

    return identicalArgsCalls.length;
  }

  private canonicalStringify(obj: any): string {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return '[' + obj.map(item => this.canonicalStringify(item)).join(',') + ']';
    }
    const keys = Object.keys(obj).sort();
    const keyPairs = keys.map(key => `${JSON.stringify(key)}:${this.canonicalStringify(obj[key])}`);
    return '{' + keyPairs.join(',') + '}';
  }

  private hashArguments(toolName: string, args: any): string {
    try {
      const canonical = this.canonicalStringify({ toolName, args: args || {} });
      return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
    } catch {
      return `${toolName}_${Date.now()}`;
    }
  }

  public hashResultState(result: any): string {
    try {
      if (result === undefined || result === null) return 'null_result';
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
      return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
    } catch {
      return `res_${Date.now()}`;
    }
  }

  private hashStateTurn(toolName: string, result: any): string {
    try {
      const canonical = this.canonicalStringify({ toolName, result });
      return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
    } catch {
      return `turn_${Date.now()}`;
    }
  }
}
