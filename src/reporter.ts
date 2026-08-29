import { MovenKillError } from './core/errors';
import { MovenRunState, DEFAULT_CHEAPER_MODEL_MAP } from './core/run-state';
import { MovenPiiRedactor } from './core/pii';
import type { RewindReceipt } from './core/rewind';
import { safeStringify } from './core/safe-json';
import { MovenLogger } from './core/logger';

export interface MovenReporterOptions {
  apiKey?: string;
  endpoint?: string;
  maxRetries?: number;
  timeoutMs?: number;
  zeroDataRetention?: boolean;
  /** Consecutive transport failures before telemetry itself opens a cooldown (default: 5) */
  telemetryFailureThreshold?: number;
  /** Cooldown (ms) while telemetry is offline — events fail fast with zero network cost (default: 60_000) */
  telemetryCooldownMs?: number;
}

/**
 * Telemetry self-protection ("circuit breaker on the telemetry channel"):
 * when the backend is unreachable, the reporter stops hammering it after N
 * consecutive failures and fail-fasts for a cooldown window. The agent hot
 * path never blocks on telemetry — local breaker evaluation is fully
 * independent of this channel.
 */
class TelemetryBreaker {
  private consecutiveFailures: number = 0;
  private openUntil: number = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number
  ) {}

  public isOffline(): boolean {
    return Date.now() < this.openUntil;
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  public recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openUntil = Date.now() + this.cooldownMs;
      MovenLogger.warn(
        `Telemetry backend unreachable after ${this.consecutiveFailures} consecutive failures — pausing outbound telemetry for ${Math.round(this.cooldownMs / 1000)}s. In-process circuit breaker protection is NOT affected.`,
        { consecutiveFailures: this.consecutiveFailures, cooldownMs: this.cooldownMs }
      );
      this.consecutiveFailures = 0;
    }
  }
}

export class MovenReporter {
  private apiKey?: string;
  private endpoint: string;
  private maxRetries: number;
  private timeoutMs: number;
  private zeroDataRetention: boolean;
  private telemetryBreaker: TelemetryBreaker;

  constructor(apiKeyOrOptions?: string | MovenReporterOptions, endpoint?: string) {
    if (typeof apiKeyOrOptions === 'object' && apiKeyOrOptions !== null) {
      this.apiKey = apiKeyOrOptions.apiKey || (typeof process !== 'undefined' ? process.env.MOVEN_API_KEY : undefined);
      this.endpoint = apiKeyOrOptions.endpoint || (typeof process !== 'undefined' ? process.env.MOVEN_ENDPOINT : undefined) || 'https://api.moven.dev/events';
      this.maxRetries = apiKeyOrOptions.maxRetries ?? 3;
      this.timeoutMs = apiKeyOrOptions.timeoutMs ?? 5000;
      this.zeroDataRetention = apiKeyOrOptions.zeroDataRetention ?? false;
      this.telemetryBreaker = new TelemetryBreaker(
        apiKeyOrOptions.telemetryFailureThreshold ?? 5,
        apiKeyOrOptions.telemetryCooldownMs ?? 60_000
      );
    } else {
      this.apiKey = apiKeyOrOptions || (typeof process !== 'undefined' ? process.env.MOVEN_API_KEY : undefined);
      this.endpoint = endpoint || (typeof process !== 'undefined' ? process.env.MOVEN_ENDPOINT : undefined) || 'https://api.moven.dev/events';
      this.maxRetries = 3;
      this.timeoutMs = 5000;
      this.zeroDataRetention = false;
      this.telemetryBreaker = new TelemetryBreaker(5, 60_000);
    }
  }

  /**
   * Zero-Trust outbound path: EVERY telemetry payload is sanitized through
   * the PII/secret redactor before it leaves the process — prompts, tool
   * args, checkpoints and receipts included.
   */
  private async postEvent(payload: any, options: { retries?: number } = {}): Promise<Response> {
    // Telemetry breaker open → fail fast with zero network cost. The in-process
    // breaker keeps protecting the agent; only the export channel is paused.
    if (this.telemetryBreaker.isOffline()) {
      return new Response(JSON.stringify({ error: 'moven_telemetry_paused' }), {
        status: 503,
        statusText: 'Moven Telemetry Paused',
      });
    }

    const sanitized = MovenPiiRedactor.sanitizePayload(payload, {
      zeroDataRetention: this.zeroDataRetention,
      maskApiKeys: true,
      maskCreditCards: true,
      maskSsns: true,
      maskIbans: true,
    });

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['x-moven-api-key'] = this.apiKey;

    try {
      const res = await this.fetchWithRetry(this.endpoint, {
        method: 'POST',
        headers,
        body: safeStringify(sanitized),
      }, options.retries ?? this.maxRetries);
      if (res.ok) {
        this.telemetryBreaker.recordSuccess();
      } else if (res.status >= 500) {
        this.telemetryBreaker.recordFailure();
      }
      return res;
    } catch (err) {
      this.telemetryBreaker.recordFailure();
      throw err;
    }
  }

  public async sendPayload(payload: any): Promise<boolean> {
    try {
      const res = await this.postEvent(payload);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async fetchWithRetry(url: string, init: RequestInit, retries: number = this.maxRetries): Promise<Response> {
    let lastError: any;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
        const res = await fetch(url, {
          ...init,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (res.ok) return res;
        if (res.status >= 400 && res.status < 500) {
          // Client errors (e.g. 401, 403) should not retry but must be visibly surfaced
          let detail = res.statusText;
          let hint: string | undefined;
          try {
            const errorClone = res.clone();
            const errorBody = await errorClone.json();
            detail = errorBody.error || errorBody.message || res.statusText;
            hint = errorBody.hint;
          } catch {
            // keep statusText fallback
          }
          MovenLogger.error(`Telemetry Error HTTP ${res.status}: ${detail}`, { status: res.status, endpoint: this.endpoint });
          if (hint) {
            MovenLogger.warn(`Telemetry Hint: ${hint}`);
          }
          return res;
        }
      } catch (err: any) {
        lastError = err;
      }
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 200 + Math.random() * 100;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError || new Error(`Failed request to ${url} after ${retries} retries`);
  }

  public async reportKillEvent(error: MovenKillError, state: MovenRunState): Promise<boolean> {
    const workflowGraph = state.generateWorkflowGraph({ isKilled: true, errorReason: error.reason });
    const model = state.getModel() || state.options.model || state.options.currentModel || 'deepseek/deepseek-chat';
    const provider = state.options.provider || 'openrouter';

    const payload = {
      event: 'kill',
      runId: state.runId,
      agentId: state.agentId,
      agentName: state.agentName,
      framework: state.framework,
      model,
      provider,
      version: state.version,
      tags: state.tags,
      userId: state.options.userId || state.options.userEmail,
      user_request: state.userRequest || (state.options.metadata?.user_request) || (state.options.metadata?.userRequest) || state.options.userRequest || (state.options as any).userPrompt,
      user_prompt: state.userRequest || (state.options.metadata?.user_prompt) || (state.options as any).userPrompt || state.options.userRequest,
      system_prompt: state.systemPrompt || (state.options.metadata?.system_prompt) || (state.options.metadata?.systemPrompt) || (state.options as any).systemPrompt,
      prompts: state.prompts,
      messages: (state.options as any)?.messages || (state.options.metadata?.messages) || [],
      checkpoints: state.checkpointManager.getCheckpoints(),
      workflow_graph: workflowGraph,
      metadata: {
        ...(state.options.metadata || {}),
        model,
        provider,
        user_request: state.userRequest,
        user_prompt: state.userRequest,
        system_prompt: state.systemPrompt,
        workflow_graph: workflowGraph,
      },
      heuristic: error.heuristic,
      reason: error.reason,
      toolName: error.toolName,
      toolArgs: error.toolArgs,
      metrics: error.metrics,
      toolCalls: state.toolCalls,
      halted: state.halted,
      halt_reason: state.haltReason,
      cooldown_until: state.cooldownRemainingMs() > 0 ? new Date(Date.now() + state.cooldownRemainingMs()).toISOString() : null,
      compensations: state.compensations.list(),
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await this.postEvent(payload);
      return response.ok;
    } catch (err: any) {
      if (!this.apiKey) {
        MovenLogger.warn(`Standalone Mode — Circuit Breaker Tripped! Run: ${state.runId} | Reason: ${error.reason}`);
      } else {
        MovenLogger.warn(`Failed to transmit kill event to backend: ${err?.message || String(err)}`);
      }
      return false;
    }
  }

  /**
   * Persists a rewind receipt to api.moven.dev → `rewind_receipts` +
   * `rewind_call_outcomes` + `tool_cooldowns` + `agent_halt_state` tables,
   * and upserts the registered compensations (inverse operations) into
   * `tool_compensations` so the dashboard can show exactly what is reversible.
   */
  public async reportRewindReceipt(receipt: RewindReceipt, state: MovenRunState): Promise<boolean> {
    const payload = {
      event: 'rewind_receipt',
      runId: state.runId,
      agentId: state.agentId,
      agentName: state.agentName,
      framework: state.framework,
      model: state.getModel(),
      provider: state.options.provider || 'openrouter',
      version: state.version,
      tags: state.tags,
      userId: state.options.userId || state.options.userEmail,
      user_request: state.userRequest,
      user_prompt: state.userRequest,
      system_prompt: state.systemPrompt,
      receipt,
      // Serializable inverse-operation registry → tool_compensations table
      compensations: state.compensations.list(),
      halted: state.halted,
      halt_reason: state.haltReason,
      metadata: {
        ...(state.options.metadata || {}),
        offending_tool: receipt.offendingTool,
        checkpoint_key: receipt.checkpoint.key,
      },
      timestamp: new Date().toISOString(),
    };

    try {
      const res = await this.postEvent(payload);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Reports a completed normal trace execution with full prompt, spans, and checkpoints.
   */
  public async reportTrace(state: MovenRunState, extra?: Record<string, any>): Promise<boolean> {
    const workflowGraph = state.generateWorkflowGraph({ isKilled: false });
    const model = state.getModel() || state.options.model || state.options.currentModel || 'deepseek/deepseek-chat';
    const provider = state.options.provider || 'openrouter';
    const metrics = state.getMetrics();

    const userPrompt = state.userRequest || extra?.user_prompt || extra?.user_request || (state.options as any).userPrompt || state.options.userRequest || 'Autonomous agent execution';
    const systemPrompt = state.systemPrompt || extra?.system_prompt || (state.options as any).systemPrompt;
    const messages = (state.options as any)?.messages || extra?.messages || [];

    const payload = {
      event: 'tool',
      runId: state.runId,
      agentId: state.agentId,
      agentName: state.agentName,
      framework: state.framework,
      model,
      provider,
      version: state.version,
      tags: state.tags,
      userId: state.options.userId || state.options.userEmail,
      user_request: userPrompt,
      user_prompt: userPrompt,
      system_prompt: systemPrompt,
      prompts: state.prompts,
      messages,
      checkpoints: state.checkpointManager.getCheckpoints(),
      toolCalls: state.toolCalls,
      workflow_graph: workflowGraph,
      // Flat top-level fields so the backend can persist tokens & cost on 200 OK runs
      total_cost: metrics.totalCost,
      total_tokens: metrics.totalTokens,
      prompt_tokens: metrics.promptTokens,
      completion_tokens: metrics.completionTokens,
      step_count: metrics.totalToolCalls,
      duration_ms: metrics.durationMs,
      metrics: {
        totalCost: metrics.totalCost,
        totalToolCalls: metrics.totalToolCalls,
        promptTokens: metrics.promptTokens,
        completionTokens: metrics.completionTokens,
        totalTokens: metrics.totalTokens,
        durationMs: metrics.durationMs,
        moneySaved: metrics.moneySaved,
      },
      metadata: {
        ...(state.options.metadata || {}),
        model,
        provider,
        user_request: userPrompt,
        user_prompt: userPrompt,
        system_prompt: systemPrompt,
        workflow_graph: workflowGraph,
        ...(extra || {}),
      },
      timestamp: new Date().toISOString(),
    };

    try {
      const res = await this.postEvent(payload);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Sends the agent's initial configuration to the backend on run start.
   * This upserts the agent record in the `agents` table so the dashboard
   * always reflects the live SDK settings (thresholds, cheaper model, etc).
   */
  public async reportRunStart(state: MovenRunState): Promise<void> {
    const model = state.getModel() || state.options.model || state.options.currentModel || 'deepseek/deepseek-chat';
    const provider = state.options.provider || 'openrouter';

    const payload = {
      event: 'start',
      runId: state.runId,
      agentId: state.agentId,
      agentName: state.agentName,
      framework: state.framework,
      model,
      provider,
      version: state.version,
      tags: state.tags,
      user_request: state.userRequest,
      user_prompt: state.userRequest,
      system_prompt: state.systemPrompt,
      timestamp: new Date().toISOString(),
      // Send full agent circuit breaker settings so backend can upsert them
      agentConfig: {
        max_repeat_calls: state.options.maxRepeatCalls ?? 5,
        max_cost_dollar: state.options.maxCostDollar ?? 2.00,
        max_depth: state.options.maxDepth ?? 15,
        max_no_progress_turns: state.options.maxNoProgressTurns ?? 3,
        cheaper_model: state.options.cheaperModel || state.getCheaperModel(),
        auto_fallback_cheaper_model: state.options.autoFallbackCheaperModel ?? true,
        current_model: model,
        provider,
      },
    };

    // Always try to send, even without API key (for local dev)
    try {
      const res = await this.postEvent(payload, { retries: 2 });

      // If backend returns updated rules, overwrite local state with cloud settings
      if (res.ok) {
        try {
          const data = await res.json();
          const pol = data.policy || data.agentConfig;
          if (pol) {
            state.updateOptions({
              maxRepeatCalls: pol.maxRepeatCalls ?? pol.max_repeat_calls,
              maxCostDollar: pol.maxCostDollar ?? pol.max_cost_dollar,
              maxDepth: pol.maxDepth ?? pol.max_depth,
              maxNoProgressTurns: pol.maxNoProgressTurns ?? pol.max_no_progress_turns ?? pol.max_no_progressturns,
              cheaperModel: pol.cheaperModel ?? pol.cheaper_model,
              fallbackModel: pol.fallbackModel ?? pol.fallback_model,
              autoFallbackCheaperModel: pol.autoFallbackCheaperModel ?? pol.auto_fallback_cheaper_model,
              enableSemanticCache: pol.enableSemanticCache ?? pol.enable_semantic_cache,
              semanticCache: pol.semanticCache || (pol.semantic_cache_threshold ? {
                similarityThreshold: pol.semantic_cache_threshold,
                ttlMs: (pol.semantic_cache_ttl_seconds || 3600) * 1000,
              } : undefined),
              semanticFingerprint: pol.semanticFingerprint || (pol.semantic_similarity_threshold ? {
                similarityThreshold: pol.semantic_similarity_threshold,
              } : undefined),
              maxErrorRatePct: pol.maxErrorRatePct ?? pol.max_error_rate_pct,
              maxSlowCallLatencyMs: pol.maxSlowCallLatencyMs ?? pol.max_slow_call_latency_ms,
              maxSlowCallRatePct: pol.maxSlowCallRatePct ?? pol.max_slow_call_rate_pct,
              maxSchemaValidationFailures: pol.maxSchemaValidationFailures ?? pol.max_schema_validation_failures,
              maxTokensPerStep: pol.maxTokensPerStep ?? pol.max_tokens_per_step,
              enableStructuralValidation: pol.enableStructuralValidation ?? pol.enable_structural_validation,
              enableGlobalBackoff: pol.enableGlobalBackoff ?? pol.enable_global_backoff,
              slidingWindowRequests: pol.slidingWindowRequests ?? pol.sliding_window_requests,
              safeToRetryTools: pol.safeToRetryTools ?? pol.safe_to_retry_tools,
              pollingTtlSeconds: pol.pollingTtlSeconds ?? pol.polling_ttl_seconds,
              readOnlyTools: pol.readOnlyTools ?? pol.read_only_tools,
              dryRun: pol.dryRun ?? pol.dry_run,
              pauseOnTrip: pol.pauseOnTrip ?? pol.pause_on_trip,
              promptFirewall: pol.promptFirewall || (pol.firewall_enabled !== undefined ? {
                enabled: pol.firewall_enabled,
                sensitivity: pol.firewall_sensitivity || 'HIGH',
                blockDirectInjections: pol.block_direct_injections,
                blockSystemPromptLeaks: pol.block_system_prompt_leaks,
                blockJailbreaks: pol.block_jailbreaks,
                customBlockedPhrases: pol.custom_blocked_phrases,
              } : undefined),
              layer2: pol.layer2 || (pol.layer2_enabled !== undefined ? {
                enabled: pol.layer2_enabled,
                mode: pol.layer2_mode,
                redundancyThreshold: pol.layer2_redundancy_threshold,
                driftThreshold: pol.layer2_drift_threshold,
                noveltyThreshold: pol.layer2_novelty_threshold,
                usefulThreshold: pol.layer2_useful_threshold,
                hysteresisEnabled: pol.layer2_hysteresis_enabled,
                blockThreshold: pol.layer2_block_threshold,
                recoverThreshold: pol.layer2_recover_threshold,
                actionMemoryWindow: pol.layer2_action_memory_window,
                factMemoryWindow: pol.layer2_fact_memory_window,
              } : undefined),
            });
          }
          if (data.globalCheaperModelMap) {
            Object.assign(DEFAULT_CHEAPER_MODEL_MAP, data.globalCheaperModelMap);
          }
        } catch {
          // Response may not be JSON, ignore
        }
      }
    } catch {
      // Ignore background start errors — SDK operates standalone
    }
  }
}
