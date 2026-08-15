import { MovenKillError } from './core/errors';
import { MovenRunState, DEFAULT_CHEAPER_MODEL_MAP } from './core/run-state';

export interface MovenReporterOptions {
  apiKey?: string;
  endpoint?: string;
  maxRetries?: number;
  timeoutMs?: number;
  batchIntervalMs?: number;
}

export class MovenReporter {
  private apiKey?: string;
  private endpoint: string;
  private maxRetries: number;
  private timeoutMs: number;

  constructor(apiKeyOrOptions?: string | MovenReporterOptions, endpoint?: string) {
    if (typeof apiKeyOrOptions === 'object' && apiKeyOrOptions !== null) {
      this.apiKey = apiKeyOrOptions.apiKey || (typeof process !== 'undefined' ? process.env.MOVEN_API_KEY : undefined);
      this.endpoint = apiKeyOrOptions.endpoint || (typeof process !== 'undefined' ? process.env.MOVEN_ENDPOINT : undefined) || 'http://localhost:3000/api/events';
      this.maxRetries = apiKeyOrOptions.maxRetries ?? 3;
      this.timeoutMs = apiKeyOrOptions.timeoutMs ?? 5000;
    } else {
      this.apiKey = apiKeyOrOptions || (typeof process !== 'undefined' ? process.env.MOVEN_API_KEY : undefined);
      this.endpoint = endpoint || (typeof process !== 'undefined' ? process.env.MOVEN_ENDPOINT : undefined) || 'http://localhost:3000/api/events';
      this.maxRetries = 3;
      this.timeoutMs = 5000;
    }
  }

  public async sendPayload(payload: any): Promise<boolean> {
    try {
      const res = await this.fetchWithRetry(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { 'x-moven-api-key': this.apiKey } : {}),
        },
        body: JSON.stringify(payload),
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
          // Client errors (e.g. 401, 403) should not retry
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
    const payload = {
      event: 'kill',
      runId: state.runId,
      agentId: state.agentId,
      agentName: state.agentName,
      framework: state.framework,
      version: state.version,
      tags: state.tags,
      userId: state.options.userId || state.options.userEmail,
      user_request: state.userRequest || (state.options.metadata?.user_request) || (state.options.metadata?.userRequest),
      system_prompt: state.systemPrompt || (state.options.metadata?.system_prompt) || (state.options.metadata?.systemPrompt),
      prompts: state.prompts,
      checkpoints: state.checkpointManager.getCheckpoints(),
      metadata: {
        ...(state.options.metadata || {}),
        user_request: state.userRequest,
        system_prompt: state.systemPrompt,
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
    const payload = {
      event: 'tool',
      runId: state.runId,
      agentId: state.agentId,
      agentName: state.agentName,
      framework: state.framework,
      version: state.version,
      tags: state.tags,
      userId: state.options.userId || state.options.userEmail,
      user_request: state.userRequest || extra?.user_request || 'Autonomous agent execution',
      system_prompt: state.systemPrompt || extra?.system_prompt,
      prompts: state.prompts,
      checkpoints: state.checkpointManager.getCheckpoints(),
      toolCalls: state.toolCalls,
      metrics: {
        totalCost: state.cumulativeCost,
        totalToolCalls: state.toolCalls.length,
        durationMs: Date.now() - state.startTime,
      },
      metadata: {
        ...(state.options.metadata || {}),
        user_request: state.userRequest,
        system_prompt: state.systemPrompt,
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
    const payload = {
      event: 'start',
      runId: state.runId,
      agentId: state.agentId,
      agentName: state.agentName,
      framework: state.framework,
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
        current_model: state.options.currentModel || '',
        provider: state.options.provider || '',
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
          if (data.agentConfig) {
            state.updateOptions({
              maxRepeatCalls: data.agentConfig.max_repeat_calls,
              maxCostDollar: data.agentConfig.max_cost_dollar,
              maxDepth: data.agentConfig.max_depth,
              maxNoProgressTurns: data.agentConfig.max_no_progress_turns,
              cheaperModel: data.agentConfig.cheaper_model,
              autoFallbackCheaperModel: data.agentConfig.auto_fallback_cheaper_model,
              enableLlmJudgeArbitrator: data.agentConfig.enable_llm_judge_arbitrator,
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
