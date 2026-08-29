import crypto from 'crypto';
import { MovenKillError, MovenKillMetrics } from './errors';
import { safeStringify, stableHashInput } from './safe-json';
import { BurnGuardOptions, MovenOvernightBurnGuard } from './burn-guard';
import { SemanticCacheOptions } from './semantic-cache';
import { MovenCheckpointManager, MovenCompensationRegistry, CompensationInput } from './checkpoint';
import { SemanticFingerprintOptions, SemanticFingerprintEngine } from './semantic-fingerprint';
import { MovenDynamicPricingEngine } from './pricing';
import { PromptFirewallConfig } from './prompt-firewall';
import { Layer2Options, MovenLayer2Guard, Layer2DecisionResult } from './layer2';
import { MovenOtelOptions, MovenOtelExporter } from '../otel';
import { validateAndClampOptions } from './option-validation';
import { MovenInstructionClassifier, extractCallTerms, termOverlap } from './intent-classifier';
import { MovenAdaptiveLoopEngine } from './adaptive-loop';
import { MovenLogger } from './logger';

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
  agentId?: string; // Unique agent identifier (e.g. 'agent_inventory_prod_01')
  agentName?: string; // Production agent name identifier
  userId?: string; // End-user / person identifier (e.g. 'user_88241', 'srini@company.com')
  userEmail?: string; // Optional user email
  userRequest?: string; // High-level user goal or prompt driving this run
  userPrompt?: string; // The raw user prompt text (alias for userRequest, used by prompt firewall)
  goal?: string; // Alias for userRequest
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
  /** @deprecated legacy alias for `fallbackModel` — the cheap model used for fallback routing */
  judgeModel?: string;
  /** Cheap fallback model ID used when routing down (default: 'google/gemini-2.5-flash-lite') */
  fallbackModel?: string;
  provider?: 'openai' | 'anthropic' | 'google' | 'cohere' | 'mistral' | 'groq' | 'openrouter' | string;
  model?: string; // Primary model ID (e.g. 'deepseek/deepseek-chat', 'openai/gpt-4o')
  modelAuthor?: string; // The model family author (e.g. 'openai' from 'openai/gpt-4o-mini')
  currentModel?: string; // The exact model ID the user's code is running
  cheaperModel?: string; // Explicit cheaper fallback model ID (e.g. 'google/gemini-2.5-flash-lite')
  cheaperModelMap?: Record<string, string>; // Mapping of provider/primary model -> cheaper model
  autoFallbackCheaperModel?: boolean; // default: true
  /** Soft (opt-in) cost ceiling: allows 25% headroom when the run is demonstrably making progress. Default: hard ceiling. */
  softCostCeiling?: boolean;
  burnGuard?: BurnGuardOptions; // Overnight Burn Guard ($2000 loss prevention engine)
  enableSemanticCache?: boolean; // Semantic caching engine enabled flag (default: true)
  semanticCache?: SemanticCacheOptions; // Semantic caching engine options
  enableSemanticFingerprint?: boolean; // Semantic Fingerprint loop detection enabled flag (default: true)
  semanticFingerprint?: SemanticFingerprintOptions; // Semantic Fingerprint loop detection layer
  enablePromptInjectionFirewall?: boolean; // Real-time prompt injection & jailbreak firewall (default: true)
  promptFirewall?: PromptFirewallConfig; // Advanced firewall sensitivity and custom patterns
  layer2?: Layer2Options; // Layer 2: Semantic Guard (In-process hot path classifier)

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

  // ─── USER-INTENT ATTESTATION (human-directed repetition tolerance) ────
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

  // ─── PRE-TRIP MODEL WARNINGS (self-correction instead of instant kill) ──
  /**
   * When enabled (default), the breaker queues a WARNING for the model when
   * a pattern is one call away from tripping (repeat / no-progress). The
   * LangGraph / Vercel model wrappers inject it into the next model
   * invocation so the LLM can change strategy before the kill.
   */
  warnBeforeTrip?: boolean;

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
  endpoint?: string; // default: https://api.moven.dev/events
  /** OpenTelemetry export of breaker decisions + tool-call spans (see src/otel.ts). Auto-on when OTEL_EXPORTER_OTLP_ENDPOINT is set. */
  otel?: MovenOtelOptions;
  onKill?: (error: any) => void;
  onPause?: (info: { agentName: string; reason: string; toolName?: string; args?: any; resumeToken: string }) => void;
  onHallucination?: (info: { agentName: string; reason: string; toolName?: string; args?: any }) => void;
  onRewind?: (receipt: any) => void;
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
  /** Flag: has the user prompt already been scanned by the prompt injection firewall */
  public _userPromptScanned: boolean = false;

  /** SRE Telemetry: Sliding window of recent call statuses (true = success, false = error) */
  public recentCallOutcomes: { timestamp: number; success: boolean; latencyMs: number; isSchemaFailure?: boolean }[] = [];
  /** Consecutive structural schema validation failures counter */
  public consecutiveSchemaFailures: number = 0;
  /** Max tokens generated in a single step (burst tracking) */
  public lastStepTokenCount: number = 0;
  /** Global backoff epoch in ms */
  public globalBackoffUntil: number = 0;
  /** Layer 2: Semantic Guard In-Process Instance */
  public layer2Guard: MovenLayer2Guard;
  /** Latest Layer 2 decision result */
  public lastLayer2Result?: Layer2DecisionResult;
  /**
   * Per-run rolling hourly spend window (timestamp, cost) used by the
   * Overnight Burn Guard's velocity check. Scoped to THIS run — no
   * cross-run contamination from static shared state.
   */
  public hourlySpendWindow: { timestamp: number; cost: number }[] = [];
  /**
   * Grace steps granted after an auto-fallback switch: loop-detection
   * heuristics (repeat / no-progress / semantic / layer2) are suppressed
   * for this many tool calls so the cheaper model gets a fair chance to
   * show progress. Hard limits (cost, depth, burn guard, firewall,
   * hallucination, SRE) stay active the whole time.
   */
  public fallbackGraceSteps: number = 0;

  /** Epoch ms until which tool calls are attested as human-directed. */
  public humanAttestUntil: number = 0;

  /**
   * The ACTIVE attestation produced by the instruction-intent classifier:
   * confidence, extracted repetition budget, and topic terms used to match
   * the directive to the tool calls it actually applies to.
   */
  private attestation?: AttestationProfile;

  /** Pre-trip warnings waiting to be injected into the next model call. */
  private pendingWarnings: MovenGuardWarning[] = [];

  // ─── IN-PROCESS ORCHESTRATION STATE (rewindable — Mechanism 1) ───────────
  /** Agent context / plan. Deep-copied into every checkpoint; restored on rewind. */
  public context: Record<string, any> = {};
  /** Working scratchpad (intermediate values, partial results). Checkpointed + restored. */
  public scratchpad: Record<string, any> = {};
  /** Per-tool retry counters. Checkpointed + restored on rewind. */
  public retryCounts: Record<string, number> = {};

  // ─── HALT GATE + TOOL COOLDOWNS (post-rewind safety) ─────────────────────
  /** After a rewind the agent is halted — a human decision or re-plan is required. */
  public halted: boolean = false;
  public haltReason?: string;
  /** Set when the operator forces a re-plan step instead of a blind resume. */
  public replanRequested: boolean = false;
  /** toolName (or toolName:argsHash) → cooldown expiry epoch ms */
  public toolCooldowns: Map<string, number> = new Map();

  /** Compensating-action registry (saga) — used by the rewind engine */
  public readonly compensations = new MovenCompensationRegistry();
  /** Ctrl+Z checkpoint ledger (bounded retention) */
  public checkpointManager: MovenCheckpointManager;

  /**
   * Single-flight kill guard: guarantees the kill side-effects (banner,
   * onKill callback, cooldown, kill event) run EXACTLY once even when
   * concurrent tool executions trip the breaker in the same tick.
   */
  private killInitiated: boolean = false;

  constructor(options: MovenOptions = {}) {
    // Enterprise hardening: clamp invalid thresholds (NaN/negative/zero) into
    // safe ranges BEFORE defaults merge — a misconfigured limit must never
    // silently disable a safety ceiling.
    this.options = validateAndClampOptions({
      maxRepeatCalls: 5,
      repeatTimeWindowMs: 60000,
      maxCostDollar: 2.00,
      maxDepth: 15,
      maxNoProgressTurns: 3,
      maxToolCallHistory: 500,
      maxPromptHistory: 200,
      judgeModel: options.judgeModel || 'google/gemini-2.5-flash-lite',
      fallbackModel: options.fallbackModel || options.judgeModel || 'google/gemini-2.5-flash-lite',
      autoFallbackCheaperModel: options.autoFallbackCheaperModel ?? true,
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
    });
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
    this.layer2Guard = new MovenLayer2Guard(this.agentId, this.options.layer2);

    // OTel export: auto-enabled via OTEL_EXPORTER_OTLP_ENDPOINT (see otel.ts).
    // Only (re)configure when the caller supplied options — manual
    // MovenOtelExporter.configure() calls elsewhere are preserved.
    if (this.options.otel) {
      MovenOtelExporter.configure(this.options.otel);
    }

    // Bounded checkpoint ledger + compensation registry (saga pattern)
    this.checkpointManager = new MovenCheckpointManager(this.options.maxCheckpoints ?? 50);
    if (options.compensations) {
      for (const [toolName, comp] of Object.entries(options.compensations)) {
        this.compensations.register(toolName, comp);
      }
    }

    // Always trigger dynamic live pricing engine refresh
    MovenDynamicPricingEngine.refreshLivePricing();

    const req = options.userRequest || options.goal || options.metadata?.user_request || options.metadata?.userRequest;
    if (req) {
      this.userRequest = req;
      this.layer2Guard.memory.setGoal(this.userRequest);
      // NOTE: the INITIAL task prompt deliberately does NOT open an
      // attestation window — a first-turn instruction is the agent's job
      // description, not a license for unlimited repetition. Layer 2 and
      // loop heuristics must stay armed for agent-initiated redundancy
      // inside that first turn. Only MID-RUN user messages (or explicit
      // recordUserInstruction calls) attest.
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
    // Mid-run user messages flow through the intent classifier: only a
    // message that actually LICENSES repetition ("search it 5 times", "do
    // it again", "poll until done") opens an attestation window — a plain
    // follow-up question ("what's their PE ratio?") must not disarm loop
    // detection. A negation ("stop searching") revokes the attestation.
    if (role === 'user') {
      this.recordUserInstruction(content);
      return;
    }
    this.prompts.push({ role, content, timestamp: Date.now() });
    this.prunePrompts();
  }

  /**
   * Registers a human instruction through the instruction-intent classifier.
   * The message is classified (lexicon features → weighted score → budget
   * extraction → topic attribution); only affirmative repetition directives
   * open an attestation window, and the resulting profile determines WHICH
   * calls are attested and with what stagnation budget.
   */
  public recordUserInstruction(instruction: string): void {
    // Enterprise control: the "Allow Repeat Tool Calls If User Asks" console
    // setting maps to this flag. When disabled, the breaker treats
    // user-directed repeats like any other loop (strictest posture).
    if (this.options.enableUserIntentAttestation === false) return;
    this.prompts.push({ role: 'user', content: instruction, timestamp: Date.now() });
    this.prunePrompts();

    const threshold = this.options.intentDirectiveThreshold ?? 0.5;
    const cls = MovenInstructionClassifier.classify(instruction, threshold);
    if (cls.isRepetitionDirective) {
      this.humanAttestUntil = Date.now() + (this.options.humanAttestationWindowMs ?? 300_000);
      this.attestation = {
        until: this.humanAttestUntil,
        confidence: cls.confidence,
        kind: cls.kind,
        repetitionAllowance: cls.maxRepetitions,
        topicTerms: cls.topicTerms,
        general: cls.topicTerms.length === 0,
      };
      MovenLogger.debug('Repetition directive attested', {
        kind: cls.kind,
        confidence: cls.confidence,
        budget: cls.maxRepetitions,
        topics: cls.topicTerms,
      });
    } else {
      // Non-directive (or negation): revoke any active attestation.
      this.humanAttestUntil = 0;
      this.attestation = undefined;
    }
  }

  private prunePrompts(): void {
    const maxPrompts = this.options.maxPromptHistory ?? 200;
    if (this.prompts.length > maxPrompts) {
      this.prompts.splice(0, this.prompts.length - maxPrompts);
    }
  }

  /** The active attestation profile, or undefined when none/expired. */
  public getActiveAttestation(): AttestationProfile | undefined {
    const att = this.attestation;
    if (!att || Date.now() > att.until) return undefined;
    return att;
  }

  /**
   * Queues a pre-trip warning for the model. Deduplicated per
   * (heuristic, toolName, argsHash) within a 60s window so the same nudge is
   * never injected twice; bounded to the 5 most recent warnings.
   */
  public pushWarning(w: Omit<MovenGuardWarning, 'id' | 'createdAt'>): void {
    const now = Date.now();
    const dedupKey = `${w.heuristic}|${w.toolName || ''}|${w.argsHash || ''}`;
    this.pendingWarnings = this.pendingWarnings.filter((existing) => {
      const expired = now - existing.createdAt > 60_000;
      const duplicate = `${existing.heuristic}|${existing.toolName || ''}|${existing.argsHash || ''}` === dedupKey;
      return !expired && !duplicate;
    });
    this.pendingWarnings.push({
      ...w,
      id: `warn_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: now,
    });
    if (this.pendingWarnings.length > 5) {
      this.pendingWarnings.splice(0, this.pendingWarnings.length - 5);
    }
  }

  /** Drains all pending warnings (for injection into the next model call). */
  public drainWarnings(): MovenGuardWarning[] {
    const drained = this.pendingWarnings;
    this.pendingWarnings = [];
    return drained;
  }

  /** Warnings currently queued (non-destructive peek, for dashboards/tests). */
  public peekWarnings(): MovenGuardWarning[] {
    return [...this.pendingWarnings];
  }

  /**
   * Decides whether a specific tool call is covered by the active
   * attestation. A directive WITH topic terms ("poll the build") only
   * attests calls whose tool name/args match those terms; a general
   * directive ("do it again") attests the current call pattern as a whole.
   */
  public isCallAttested(toolName: string, args: any): boolean {
    const att = this.getActiveAttestation();
    if (!att) return false;
    if (att.general) return true;
    const callTerms = extractCallTerms(toolName, args, (a) => MovenAdaptiveLoopEngine.extractQueryString(a));
    return termOverlap(att.topicTerms, callTerms) >= 0.15;
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
    // Same enterprise clamping as the constructor — dynamic policy updates
    // from the cloud can never inject an invalid threshold either.
    const clamped = validateAndClampOptions(newRules as MovenOptions);
    if (clamped.maxRepeatCalls !== undefined) this.options.maxRepeatCalls = clamped.maxRepeatCalls;
    if (clamped.maxCostDollar !== undefined) this.options.maxCostDollar = clamped.maxCostDollar;
    if (clamped.maxDepth !== undefined) this.options.maxDepth = clamped.maxDepth;
    if (clamped.maxNoProgressTurns !== undefined) this.options.maxNoProgressTurns = clamped.maxNoProgressTurns;
    if (clamped.cheaperModel !== undefined) this.options.cheaperModel = clamped.cheaperModel;
    if (clamped.fallbackModel !== undefined) this.options.fallbackModel = clamped.fallbackModel;
    if (clamped.autoFallbackCheaperModel !== undefined) this.options.autoFallbackCheaperModel = clamped.autoFallbackCheaperModel;
    if (clamped.softCostCeiling !== undefined) this.options.softCostCeiling = clamped.softCostCeiling;
    if (clamped.enableSemanticCache !== undefined) this.options.enableSemanticCache = clamped.enableSemanticCache;
    if (clamped.semanticCache !== undefined) this.options.semanticCache = { ...this.options.semanticCache, ...clamped.semanticCache };
    if (clamped.semanticFingerprint !== undefined) this.options.semanticFingerprint = { ...this.options.semanticFingerprint, ...clamped.semanticFingerprint };
    if (clamped.maxErrorRatePct !== undefined) this.options.maxErrorRatePct = clamped.maxErrorRatePct;
    if (clamped.maxSlowCallLatencyMs !== undefined) this.options.maxSlowCallLatencyMs = clamped.maxSlowCallLatencyMs;
    if (clamped.maxSlowCallRatePct !== undefined) this.options.maxSlowCallRatePct = clamped.maxSlowCallRatePct;
    if (clamped.maxSchemaValidationFailures !== undefined) this.options.maxSchemaValidationFailures = clamped.maxSchemaValidationFailures;
    if (clamped.maxTokensPerStep !== undefined) this.options.maxTokensPerStep = clamped.maxTokensPerStep;
    if (clamped.enableStructuralValidation !== undefined) this.options.enableStructuralValidation = clamped.enableStructuralValidation;
    if (clamped.enableGlobalBackoff !== undefined) this.options.enableGlobalBackoff = clamped.enableGlobalBackoff;
    if (clamped.slidingWindowRequests !== undefined) this.options.slidingWindowRequests = clamped.slidingWindowRequests;
    if (clamped.safeToRetryTools !== undefined) this.options.safeToRetryTools = clamped.safeToRetryTools;
    if (clamped.pollingTtlSeconds !== undefined) this.options.pollingTtlSeconds = clamped.pollingTtlSeconds;
    if (clamped.readOnlyTools !== undefined) this.options.readOnlyTools = clamped.readOnlyTools;
    if (clamped.dryRun !== undefined) this.options.dryRun = clamped.dryRun;
    if (clamped.pauseOnTrip !== undefined) this.options.pauseOnTrip = clamped.pauseOnTrip;
    if (clamped.percentileStepBaseline !== undefined) this.options.percentileStepBaseline = clamped.percentileStepBaseline;
    if (clamped.promptFirewall !== undefined) this.options.promptFirewall = { ...this.options.promptFirewall, ...clamped.promptFirewall };
    if (clamped.layer2 !== undefined) this.options.layer2 = { ...this.options.layer2, ...clamped.layer2 };
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
    const fallbackJudgeModel = this.options.fallbackModel || this.options.judgeModel || 'google/gemini-2.5-flash-lite';
    if (routingLayer === 'openrouter') {
      // OpenRouter needs full "author/model" slugs
      if (cheaperBare) {
        // If cheaperBare already contains a slash it's already namespaced
        return cheaperBare.includes('/') ? cheaperBare : `${author}/${cheaperBare}`;
      }
      // Fallback to the configured fallback model on OpenRouter
      return fallbackJudgeModel;
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
    return this.options.fallbackModel || this.options.judgeModel || 'google/gemini-2.5-flash-lite';
  }

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

  /**
   * The interception point. Called BEFORE the real tool body runs — checks
   * the halt gate and cooldowns synchronously so a blocked call can never
   * reach the network (zero-proxy, in-process interception).
   * Throws MovenKillError when the call must not execute.
   */
  private interceptionGuard(toolName: string, argsHash: string): void {
    if (this.isKilled) {
      throw new MovenKillError({
        runId: this.runId,
        heuristic: 'repeat_tool_call',
        reason: 'Execution blocked: circuit breaker already tripped for this run.',
        toolName,
        metrics: this.getMetrics(),
      });
    }
    if (this.halted) {
      throw new MovenKillError({
        runId: this.runId,
        heuristic: 'repeat_tool_call',
        reason: `Execution blocked: agent is HALTED after a rewind. ${this.haltReason || 'A human decision or re-plan is required before resume.'}`,
        toolName,
        metrics: this.getMetrics(),
      });
    }
    if (this.isToolOnCooldown(toolName, argsHash)) {
      const remaining = Math.ceil(this.cooldownRemainingMs(toolName) / 1000);
      throw new MovenKillError({
        runId: this.runId,
        heuristic: 'repeat_tool_call',
        reason: `Execution blocked: tool '${toolName}' is on post-rewind cooldown (${remaining}s remaining). It cannot retrigger the identical loop until the cooldown expires or an operator clears it.`,
        toolName,
        metrics: this.getMetrics(),
      });
    }
  }

  /**
   * Single-flight kill guard. Returns true exactly once per run — concurrent
   * trippers get false and must skip duplicate side effects (banner, onKill,
   * cooldown, kill event) while still throwing their own MovenKillError.
   */
  public markKillInitiated(): boolean {
    if (this.killInitiated) return false;
    this.killInitiated = true;
    return true;
  }

  /** True once any kill path has begun for this run (single-flight guard). */
  public isKillInitiated(): boolean {
    return this.killInitiated;
  }

  public recordToolCall(toolName: string, args: any): ToolCallLog {
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
        } catch {
          /* frozen/sealed args — key still recorded on the log */
        }
      }
    }
    idempotencyKey = typeof idempotencyKey === 'string' ? idempotencyKey : undefined;

    const isPollingTool = this.isSafeToRetryTool(toolName);
    const isReadOnly = this.isReadOnlyTool(toolName);
    const humanAttested = this.isCallAttested(toolName, args);
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

    const log: ToolCallLog = {
      toolName,
      args,
      argsHash,
      timestamp: Date.now(),
      idempotencyKey,
      status: 'in_flight',
      depth: this.depth,
      isPollingTool,
      isReadOnly,
      humanAttested,
      promptTokens,
      completionTokens,
      tokens: costData.totalTokens,
      cost: costData.stepCost,
    };
    this.toolCalls.push(log);

    // Bounded ledger: keep the newest N entries. The repeat-detection window
    // (default 60s) and polling TTL scans operate on recent history, so this
    // prune never weakens detection — it only caps worst-case memory.
    const maxToolCalls = this.options.maxToolCallHistory ?? 500;
    if (this.toolCalls.length > maxToolCalls) {
      this.toolCalls.splice(0, this.toolCalls.length - maxToolCalls);
    }

    this.cumulativePromptTokens += promptTokens;
    this.cumulativeCompletionTokens += completionTokens;
    this.cumulativeTotalTokens += costData.totalTokens;
    this.cumulativeCost += costData.stepCost;
    MovenOvernightBurnGuard.recordSpend(this, costData.stepCost);

    // Consume one fallback grace step per tool call (loop-detection
    // heuristics stay suppressed while grace remains)
    if (this.fallbackGraceSteps > 0) this.fallbackGraceSteps -= 1;

    // Snapshot Ctrl+Z step checkpoint — immutable deep copy of the FULL
    // in-process orchestration state (context, scratchpad, retry counters,
    // conversation history) taken BEFORE this call can touch the outside world.
    // NOTE: created with stepIndex === this.depth === log.depth — the checkpoint
    // captures the state immediately BEFORE the call at the same depth executes.
    this.checkpointManager.createCheckpoint(
      this.runId,
      this.agentId,
      this.depth,
      toolName,
      args,
      this.cumulativeCost,
      this.prompts.slice(-50),
      { toolArgs: args, reasoning: this.reasoningSteps[this.reasoningSteps.length - 1] },
      this.systemPrompt,
      this.userRequest || (typeof args?.prompt === 'string' ? args.prompt : undefined),
      this.activeModel,
      `Step ${this.depth}: ${toolName}`,
      {
        context: this.context,
        scratchpad: this.scratchpad,
        retryCounts: this.retryCounts,
        turnNumber: this.depth,
      }
    );

    return log;
  }

  /** Registers a call as queued (scheduled but not started). Not checkpointed, not costed. */
  public queueToolCall(toolName: string, args: any): ToolCallLog {
    const argsHash = this.hashArguments(toolName, args);
    const log: ToolCallLog = {
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
  public pendingCalls(): ToolCallLog[] {
    return this.toolCalls.filter(c => c.status === 'queued' || c.status === 'in_flight');
  }

  /** Cancels every queued / in-flight call. Returns the cancelled logs. */
  public cancelPending(): ToolCallLog[] {
    const cancelled: ToolCallLog[] = [];
    for (const c of this.toolCalls) {
      if (c.status === 'queued' || c.status === 'in_flight') {
        c.status = 'cancelled';
        cancelled.push(c);
      }
    }
    return cancelled;
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
      // Bounded: only the most recent hashes feed no-progress / soft-ceiling checks
      if (this.stateHashes.length > 100) this.stateHashes.splice(0, this.stateHashes.length - 100);

      // Compute and store the goal-state hash (intent + result) for Semantic Fingerprint
      const intentText = log.reasoning || log.toolName;
      const intentHash = SemanticFingerprintEngine.computeIntentHash(intentText, res);
      log.intentHash = intentHash;

      // Maintain the sliding window (max 10 entries)
      const MAX_WINDOW = 10;
      this.intentHashes.push(intentHash);
      if (this.intentHashes.length > MAX_WINDOW) this.intentHashes.shift();

      // Layer 2: Asynchronously extract facts and pre-embed into memory
      if (this.layer2Guard && this.options.layer2?.enabled !== false) {
        this.layer2Guard.recordToolResult(log.toolName, log.args || {}, res);
      }
    }
  }

  // ─── ORCHESTRATION STATE MUTATORS (all rewindable) ──────────────────────
  public updateContext(patch: Record<string, any>): void {
    this.context = { ...this.context, ...patch };
  }

  public updateScratchpad(patch: Record<string, any>): void {
    this.scratchpad = { ...this.scratchpad, ...patch };
  }

  public incrementRetry(toolName: string): number {
    this.retryCounts[toolName] = (this.retryCounts[toolName] || 0) + 1;
    return this.retryCounts[toolName];
  }

  /** Register a compensating action (saga inverse) for a tool. */
  public registerCompensation(toolName: string, input: CompensationInput): void {
    this.compensations.register(toolName, input);
  }

  // ─── HALT GATE + COOLDOWNS ───────────────────────────────────────────────
  /**
   * Puts a tool on cooldown. Returns the cooldown expiry (epoch ms).
   * With argsHash the cooldown targets the identical call; without it the
   * whole tool is blocked — safer for incident response.
   */
  public applyCooldown(toolName: string | undefined, seconds: number = this.options.rewindCooldownSeconds ?? 300, argsHash?: string): number {
    if (!toolName) return 0;
    const until = Date.now() + seconds * 1000;
    this.toolCooldowns.set(argsHash ? `${toolName}:${argsHash}` : toolName, until);
    return until;
  }

  public isToolOnCooldown(toolName: string, argsHash?: string): boolean {
    const now = Date.now();
    const exact = argsHash ? this.toolCooldowns.get(`${toolName}:${argsHash}`) : undefined;
    const toolWide = this.toolCooldowns.get(toolName);
    if (exact !== undefined && exact > now) return true;
    if (toolWide !== undefined && toolWide > now) return true;
    return false;
  }

  public cooldownRemainingMs(toolName?: string): number {
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

  public clearCooldowns(): void {
    this.toolCooldowns.clear();
  }

  /**
   * Mechanism 1 rewind: pointer restoration of in-process orchestration state.
   * External side effects are NOT touched here — the rewind engine handles
   * sagas/manual-review for committed calls before invoking this.
   * Returns the number of truncated (forgotten) tool-call log entries.
   */
  public restoreFromCheckpoint(ckpt: {
    context?: Record<string, any>;
    scratchpad?: Record<string, any>;
    retryCounts?: Record<string, number>;
    messagesSnapshot?: any[];
    model?: string;
    cumulativeCost: number;
    stepIndex: number;
    timestamp: number;
  }): number {
    this.context = ckpt.context ? { ...ckpt.context } : {};
    this.scratchpad = ckpt.scratchpad ? { ...ckpt.scratchpad } : {};
    this.retryCounts = ckpt.retryCounts ? { ...ckpt.retryCounts } : {};
    if (ckpt.messagesSnapshot) {
      this.prompts = ckpt.messagesSnapshot.map(p => ({ ...p }));
    }
    if (ckpt.model) this.activeModel = ckpt.model;
    this.cumulativeCost = ckpt.cumulativeCost || 0;
    this.depth = ckpt.stepIndex - 1 < 0 ? 0 : ckpt.stepIndex - 1;

    // Keep only calls strictly BEFORE the checkpoint's step (checkpoint S is
    // captured before call S runs, so call S and everything after is undone).
    const keepCount = this.toolCalls.filter(
      c => (c.depth !== undefined ? c.depth < ckpt.stepIndex : c.timestamp <= ckpt.timestamp)
    ).length;
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

  public recordCallOutcome(success: boolean, latencyMs: number = 0, isSchemaFailure: boolean = false): void {    const MAX_WINDOW = this.options.slidingWindowRequests || 20;
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
    MovenOvernightBurnGuard.recordSpend(this, costData.stepCost);
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

  public addCost(cost: number) {
    if (cost <= 0) return;
    this.cumulativeCost += cost;
    MovenOvernightBurnGuard.recordSpend(this, cost);
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

        // Polling whitelist applies ONLY while the result state is actually
        // progressing (pending -> building -> done). A stagnant poll whose
        // output hash never changes falls through to the normal result-delta
        // repeat counting below, so it trips like any other looping tool.
        const hasProgressiveResults = pollingCalls.some(c => c.isResultProgressive);
        if (hasProgressiveResults) {
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
      // BigInt/functions/circular leaves must not throw the hot path
      return safeStringify(obj);
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
      // DETERMINISTIC fallback — a unique-per-call value here would silently
      // disable repeat detection and make idempotency keys retry-unique.
      const canonical = stableHashInput({ toolName, args: args || {} });
      return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
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
      // Deterministic fallback keeps result-delta hashing stable across retries
      const canonical = stableHashInput(result);
      return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
    }
  }

  private hashStateTurn(toolName: string, result: any): string {
    try {
      const canonical = this.canonicalStringify({ toolName, result });
      return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
    } catch {
      // DETERMINISTIC fallback — a unique-per-call value here would silently
      // disable no-progress detection (same rule as hashArguments above).
      const canonical = stableHashInput({ toolName, result });
      return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
    }
  }

  /**
   * Generates the complete ReactFlow / n8n workflow graph JSON representation
   * of this agent run, including triggers, agent node, model/memory/tool subnodes,
   * circuit breaker router, and outcome branches.
   */
  public generateWorkflowGraph(options?: { isKilled?: boolean; errorReason?: string }): {
    nodes: any[];
    edges: any[];
    viewport: { x: number; y: number; zoom: number };
    metadata: Record<string, any>;
  } {
    const isKilled = options?.isKilled ?? false;
    const model = this.getModel() || this.options.model || this.options.currentModel || this.options.fallbackModel || 'deepseek/deepseek-chat';
    const provider = this.options.provider || 'openrouter';
    const checkpoints = this.checkpointManager.getCheckpoints();
    const lastCheckpoint = checkpoints[checkpoints.length - 1];
    const checkpointId = lastCheckpoint ? `ckpt_${lastCheckpoint.traceId}_step_${lastCheckpoint.stepIndex}` : 'chk_init';
    const checkpointTurn = lastCheckpoint ? lastCheckpoint.stepIndex : 1;
    
    // Unique Tool Names
    const uniqueTools = Array.from(new Set(this.toolCalls.map(tc => tc.toolName)));
    const primaryTool = uniqueTools[0] || 'search_customer_tickets';

    // Build Nodes
    const nodes: any[] = [
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
    const edges: any[] = [
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
