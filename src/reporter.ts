import { MovenKillError } from './core/errors';
import { MovenRunState, DEFAULT_CHEAPER_MODEL_MAP } from './core/run-state';
import { MovenPiiRedactor } from './core/pii';

export interface MovenReporterOptions {
  apiKey?: string;
  endpoint?: string;
  maxRetries?: number;
  timeoutMs?: number;
  batchIntervalMs?: number;
  zeroDataRetention?: boolean;
}

export class MovenReporter {
  private apiKey?: string;
  private endpoint: string;
  private maxRetries: number;
  private timeoutMs: number;
  private zeroDataRetention: boolean;

  constructor(apiKeyOrOptions?: string | MovenReporterOptions, endpoint?: string) {
    if (typeof apiKeyOrOptions === 'object' && apiKeyOrOptions !== null) {
      this.apiKey = apiKeyOrOptions.apiKey || (typeof process !== 'undefined' ? process.env.MOVEN_API_KEY : undefined);
      this.endpoint = apiKeyOrOptions.endpoint || (typeof process !== 'undefined' ? process.env.MOVEN_ENDPOINT : undefined) || 'https://api.moven.dev/events';
      this.maxRetries = apiKeyOrOptions.maxRetries ?? 3;
      this.timeoutMs = apiKeyOrOptions.timeoutMs ?? 5000;
      this.zeroDataRetention = apiKeyOrOptions.zeroDataRetention ?? false;
    } else {
      this.apiKey = apiKeyOrOptions || (typeof process !== 'undefined' ? process.env.MOVEN_API_KEY : undefined);
      this.endpoint = endpoint || (typeof process !== 'undefined' ? process.env.MOVEN_ENDPOINT : undefined) || 'https://api.moven.dev/events';
      this.maxRetries = 3;
      this.timeoutMs = 5000;
      this.zeroDataRetention = false;
    }
  }

  public async sendPayload(payload: any): Promise<boolean> {
    try {
      // Enterprise Zero-Trust Client-Side PII Sanitization
      const sanitized = MovenPiiRedactor.sanitizePayload(payload, {
        zeroDataRetention: this.zeroDataRetention,
        maskApiKeys: true,
        maskCreditCards: true,
        maskSsns: true,
        maskIbans: true,
      });

      const res = await this.fetchWithRetry(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'x-moven-api-key': this.apiKey } : {}),
        },
        body: JSON.stringify(sanitized),
      });
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
          try {
            const errorClone = res.clone();
            const errorBody = await errorClone.json();
            console.error(`\x1b[31m[Moven Telemetry Error HTTP ${res.status}]\x1b[0m: ${errorBody.error || errorBody.message || res.statusText}`);
            if (errorBody.hint) {
              console.error(`\x1b[33m[Moven Telemetry Hint]\x1b[0m: ${errorBody.hint}`);
            }
          } catch {
            console.error(`\x1b[31m[Moven Telemetry Error HTTP ${res.status}]\x1b[0m: ${res.statusText}`);
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

  public async queryJudgeArbitrator(state: MovenRunState): Promise<{
    judgeModel: string;
    cheaperModel: string;
    pricing?: { promptPerMillion: number; completionPerMillion: number };
    reason?: string;
  } | null> {
    const judgeEndpoint = this.endpoint.replace(/\/api\/events$/, '/api/judge-arbitrator');
    try {
      const res = await this.fetchWithRetry(judgeEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: state.options.provider || 'openrouter',
          modelAuthor: state.options.modelAuthor || '',
          currentModel: state.options.currentModel || state.options.judgeModel || '',
          model: state.options.judgeModel,
          toolCalls: state.toolCalls,
          agentId: state.agentId,
          agentName: state.agentName,
          framework: state.framework,
          version: state.version,
          tags: state.tags,
        }),
      }, 1);
      if (res.ok) {
        const data = await res.json();
        if (data.circuitRules) {
          state.updateOptions(data.circuitRules);
        }
        return data;
      }
    } catch {
      // Fallback silently without throwing to maintain Zero Overhead guarantee
    }
    return null;
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
      user_request: state.userRequest || (state.options.metadata?.user_request) || (state.options.metadata?.userRequest),
      system_prompt: state.systemPrompt || (state.options.metadata?.system_prompt) || (state.options.metadata?.systemPrompt),
      prompts: state.prompts,
      checkpoints: state.checkpointManager.getCheckpoints(),
      workflow_graph: workflowGraph,
      metadata: {
        ...(state.options.metadata || {}),
        model,
        provider,
        user_request: state.userRequest,
        system_prompt: state.systemPrompt,
        workflow_graph: workflowGraph,
      },
      heuristic: error.heuristic,
      reason: error.reason,
      toolName: error.toolName,
      toolArgs: error.toolArgs,
      metrics: error.metrics,
      toolCalls: state.toolCalls,
      timestamp: new Date().toISOString(),
    };

    // Note: If no API key is provided, still attempt local endpoint POST for dashboard telemetry & webhooks
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['x-moven-api-key'] = this.apiKey;

      const response = await this.fetchWithRetry(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      return response.ok;
    } catch (err: any) {
      if (!this.apiKey) {
        console.log(`[Moven AI] Standalone Mode — Circuit Breaker Tripped! Run: ${state.runId} | Reason: ${error.reason}`);
      } else {
        console.warn(`[Moven AI] Failed to transmit kill event to backend: ${err.message}`);
      }
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
      user_request: state.userRequest || extra?.user_request || 'Autonomous agent execution',
      system_prompt: state.systemPrompt || extra?.system_prompt,
      prompts: state.prompts,
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
        user_request: state.userRequest,
        system_prompt: state.systemPrompt,
        workflow_graph: workflowGraph,
        ...(extra || {}),
      },
      timestamp: new Date().toISOString(),
    };

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['x-moven-api-key'] = this.apiKey;

      const res = await this.fetchWithRetry(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
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
        enable_llm_judge_arbitrator: state.options.enableLlmJudgeArbitrator ?? true,
        current_model: model,
        provider,
      },
    };

    // Always try to send, even without API key (for local dev)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['x-moven-api-key'] = this.apiKey;

      const res = await this.fetchWithRetry(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }, 2);

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
              autoFallbackCheaperModel: pol.autoFallbackCheaperModel ?? pol.auto_fallback_cheaper_model,
              enableLlmJudgeArbitrator: pol.enableLlmJudgeArbitrator ?? pol.enable_llm_judge_arbitrator ?? pol.enable_llm_judge,
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
