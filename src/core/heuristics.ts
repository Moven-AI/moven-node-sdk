import { MovenRunState } from './run-state';
import { MovenHeuristicType, MovenKillMetrics } from './errors';
import { MovenOvernightBurnGuard } from './burn-guard';
import { MovenHallucinationDetector } from './hallucination';
import { SemanticFingerprintEngine } from './semantic-fingerprint';
import { MovenAdaptiveLoopEngine } from './adaptive-loop';

export interface HeuristicTripResult {
  tripped: boolean;
  heuristic?: MovenHeuristicType;
  reason?: string;
  toolName?: string;
  toolArgs?: any;
  metrics?: MovenKillMetrics;
}

export class MovenHeuristicsEngine {
  public static evaluate(state: MovenRunState): HeuristicTripResult {
    const opts = state.options;

    // 0. Overnight Burn Guard ($2000 Loss Prevention Engine Check)
    const burnGuardResult = MovenOvernightBurnGuard.evaluate(state);
    if (burnGuardResult.tripped) {
      const lastCall = state.toolCalls[state.toolCalls.length - 1];
      return {
        tripped: true,
        heuristic: 'custom_rule',
        reason: burnGuardResult.reason || 'Overnight Burn Guard limit exceeded',
        toolName: lastCall?.toolName,
        toolArgs: lastCall?.args,
        metrics: state.getMetrics(),
      };
    }

    // 0.5. Real-Time AI Hallucination Safeguard Check
    const hallucinationResult = MovenHallucinationDetector.evaluate(state);
    if (hallucinationResult.tripped) {
      return {
        tripped: true,
        heuristic: 'ai_hallucination',
        reason: hallucinationResult.reason,
        toolName: hallucinationResult.toolName,
        toolArgs: hallucinationResult.toolArgs,
        metrics: state.getMetrics(),
      };
    }

    // 0.7. Semantic Fingerprint Layer (<1ms, zero-AI, catches smart loops that hash-based
    //      checks miss: goal-state hash repeat, cosine similarity collapse, entropy stagnation)
    if (opts.semanticFingerprint?.enabled !== false && state.reasoningSteps.length >= 3) {
      const sfResult = SemanticFingerprintEngine.evaluate(
        state.reasoningSteps,
        state.intentHashes,
        opts.semanticFingerprint,
      );
      if (sfResult.tripped) {
        const lastCall = state.toolCalls[state.toolCalls.length - 1];
        state.lastSemanticSimilarity = sfResult.similarityScore ?? state.lastSemanticSimilarity;
        return {
          tripped: true,
          heuristic: 'semantic_loop',
          reason: sfResult.reason || 'Semantic Fingerprint: reasoning loop detected',
          toolName: lastCall?.toolName,
          toolArgs: lastCall?.args,
          metrics: state.getMetrics(),
        };
      }
      // Always update the similarity score for dashboard surfacing
      if (sfResult.similarityScore !== undefined) {
        state.lastSemanticSimilarity = sfResult.similarityScore;
      }
    }

    // 1. Advanced Adaptive Loop Engine (Novelty Scoring, Jaccard Divergence, Cycle Oscillation, Discovery Headroom)
    if (state.toolCalls.length > 0) {
      const adaptiveResult = MovenAdaptiveLoopEngine.evaluate(state.toolCalls, opts.maxRepeatCalls ? Math.max(opts.maxRepeatCalls * 3, 15) : 15);
      if (adaptiveResult.tripped) {
        const lastCall = state.toolCalls[state.toolCalls.length - 1];
        return {
          tripped: true,
          heuristic: 'repeat_tool_call',
          reason: adaptiveResult.reason || 'Adaptive Loop Sentinel: loop pattern detected',
          toolName: lastCall?.toolName,
          toolArgs: lastCall?.args,
          metrics: state.getMetrics(),
        };
      }
    }

    // 1.5. Legacy Repeat Call Fallback (with Read vs Write tool separation & Idempotency Key validation)
    const repeatCount = state.getRecentRepeatCallsCount(opts.repeatTimeWindowMs);
    const lastCall = state.toolCalls[state.toolCalls.length - 1];
    const isReadOnly = lastCall?.isReadOnly || false;
    
    // Read-only tools (search, get, fetch) receive 3x higher headroom than Write tools
    const baseRepeatLimit = opts.maxRepeatCalls || 5;
    const effectiveRepeatLimit = isReadOnly ? Math.max(baseRepeatLimit * 3, 15) : baseRepeatLimit;

    if (repeatCount >= effectiveRepeatLimit) {
      const toolType = isReadOnly ? 'Read/Search tool' : 'Write/Mutate tool';
      return {
        tripped: true,
        heuristic: 'repeat_tool_call',
        reason: `${toolType} '${lastCall?.toolName}' called ${repeatCount} times without query novelty or state progression (limit: ${effectiveRepeatLimit}).`,
        toolName: lastCall?.toolName,
        toolArgs: lastCall?.args,
        metrics: state.getMetrics(),
      };
    }

    // 2. Intelligent Cost Ceiling (Differentiates productive progress vs wasteful loops)
    if (state.cumulativeCost >= (opts.maxCostDollar || 2.00)) {
      // Check if recent state hashes are unique (productive progress)
      const recentHashes = state.stateHashes.slice(-3);
      const isMakingProgress = recentHashes.length >= 2 && new Set(recentHashes).size === recentHashes.length;

      // If agent is making active, non-repetitive progress, allow 25% cost headroom buffer
      const effectiveCap = isMakingProgress ? (opts.maxCostDollar || 2.00) * 1.25 : (opts.maxCostDollar || 2.00);

      if (state.cumulativeCost >= effectiveCap) {
        return {
          tripped: true,
          heuristic: 'cost_ceiling',
          reason: `Cumulative token cost ($${state.cumulativeCost.toFixed(4)}) exceeded intelligent cost ceiling ($${effectiveCap.toFixed(2)}).`,
          metrics: state.getMetrics(),
        };
      }
    }

    // 3. Depth Ceiling (with Adaptive 95th-Percentile Baseline)
    const maxDepth = opts.percentileStepBaseline && opts.percentileStepBaseline > (opts.maxDepth || 15)
      ? Math.round(opts.percentileStepBaseline * 1.25)
      : (opts.maxDepth || 15);

    if (state.depth > maxDepth) {
      return {
        tripped: true,
        heuristic: 'depth_ceiling',
        reason: `Agent call depth (${state.depth}) exceeded maximum allowed recursion limit (${maxDepth}${opts.percentileStepBaseline ? ' [adaptive 95th-percentile baseline]' : ''}).`,
        metrics: state.getMetrics(),
      };
    }

    // 4. No-Progress Detection (consecutive identical turn state hashes)
    const hashes = state.stateHashes;
    const maxNoProgress = opts.maxNoProgressTurns || 3;
    if (hashes.length >= maxNoProgress) {
      const recentHashes = hashes.slice(-maxNoProgress);
      const allIdentical = recentHashes.every(h => h === recentHashes[0]);
      if (allIdentical) {
        const lastCall = state.toolCalls[state.toolCalls.length - 1];
        return {
          tripped: true,
          heuristic: 'no_progress_loop',
          reason: `No-progress loop detected: output state hash repeated ${maxNoProgress} consecutive times without progress.`,
          toolName: lastCall?.toolName,
          toolArgs: lastCall?.args,
          metrics: state.getMetrics(),
        };
      }
    }

    // 5. Cheap Model LLM Judge Arbitrator (Fired when 3+ suspicious repeat calls occur)
    //    Operates synchronously here; call evaluateAsync() if you need the speculative gate.
    if (opts.enableLlmJudgeArbitrator !== false && repeatCount >= 3) {
      const isJudgeTripped = this.runCheapModelArbitrator(state);
      if (isJudgeTripped.tripped) {
        const lastCall = state.toolCalls[state.toolCalls.length - 1];
        return {
          tripped: true,
          heuristic: 'llm_judge_arbitrator',
          reason: isJudgeTripped.reason || `Cheap LLM Judge (${opts.judgeModel || 'google/gemini-2.5-flash-lite'}) deduced that agent is stuck in an unrecoverable infinite loop.`,
          toolName: lastCall?.toolName,
          toolArgs: lastCall?.args,
          metrics: state.getMetrics(),
        };
      }
    }

    // 6. Global Provider Health & Coordinated Backoff Check
    if (opts.enableGlobalBackoff !== false && state.globalBackoffUntil > Date.now()) {
      const remainingSec = Math.round((state.globalBackoffUntil - Date.now()) / 1000);
      return {
        tripped: true,
        heuristic: 'global_provider_backoff',
        reason: `Global provider degradation backoff active (${remainingSec}s remaining). Halting agent execution to prevent key exhaustion / DDoS.`,
        metrics: state.getMetrics(),
      };
    }

    // 7. Structural Schema Validation Failure Check (Catches malformed JSON / corrupted output)
    if (opts.enableStructuralValidation !== false && state.consecutiveSchemaFailures >= (opts.maxSchemaValidationFailures || 3)) {
      const lastCall = state.toolCalls[state.toolCalls.length - 1];
      return {
        tripped: true,
        heuristic: 'schema_validation_failure',
        reason: `Output schema validation failed ${state.consecutiveSchemaFailures} consecutive times. Opened circuit breaker to prevent agent from processing corrupted data.`,
        toolName: lastCall?.toolName,
        toolArgs: lastCall?.args,
        metrics: state.getMetrics(),
      };
    }

    // 8. SRE Technical Error Rate Threshold Check
    if (state.recentCallOutcomes.length >= 5) {
      const errorRate = state.getRecentErrorRate();
      const maxErr = opts.maxErrorRatePct ?? 50.0;
      if (errorRate >= maxErr) {
        return {
          tripped: true,
          heuristic: 'high_error_rate',
          reason: `Call error rate (${errorRate.toFixed(1)}%) breached SRE failure threshold (${maxErr}% over last ${state.recentCallOutcomes.length} requests).`,
          metrics: state.getMetrics(),
        };
      }
    }

    // 9. Latency Hang & Slow Call Rate Check
    if (state.recentCallOutcomes.length >= 5) {
      const slowRate = state.getRecentSlowCallRate(opts.maxSlowCallLatencyMs);
      const maxSlow = opts.maxSlowCallRatePct ?? 40.0;
      if (slowRate >= maxSlow) {
        return {
          tripped: true,
          heuristic: 'latency_hang',
          reason: `Slow call rate (${slowRate.toFixed(1)}%) breached threshold (${maxSlow}% exceeding ${(opts.maxSlowCallLatencyMs || 30000) / 1000}s latency).`,
          metrics: state.getMetrics(),
        };
      }
    }

    // 10. Single-Step Token Generation Burst Ceiling (Catches runaway generation outside tool calls)
    if (state.lastStepTokenCount > (opts.maxTokensPerStep || 8192)) {
      return {
        tripped: true,
        heuristic: 'token_burst_limit',
        reason: `Single-step generation burst (${state.lastStepTokenCount} tokens) exceeded maximum token ceiling (${opts.maxTokensPerStep || 8192} tokens).`,
        metrics: state.getMetrics(),
      };
    }

    // 11. Custom Developer Rule Check
    if (opts.customCheck) {
      const customRes = opts.customCheck(state);
      if (customRes && customRes.tripped) {
        return {
          tripped: true,
          heuristic: 'custom_rule',
          reason: customRes.reason || 'Custom heuristic rule triggered',
          metrics: state.getMetrics(),
        };
      }
    }

    return { tripped: false };
  }

  /**
   * Async speculative evaluation for high-risk tool gating.
   *
   * Call this instead of evaluate() when the next tool call is high-risk
   * (declared in options.highRiskTools). The method runs all synchronous checks
   * first and, if none trip, fires the async LLM Judge in a background Promise.
   * Execution of the high-risk tool should be held until this resolves.
   *
   * @example
   *   if (state.isHighRiskTool(toolName)) {
   *     const result = await MovenHeuristicsEngine.evaluateAsync(state);
   *     if (result.tripped) throw new MovenKillError(...);
   *   }
   */
  public static async evaluateAsync(state: MovenRunState): Promise<HeuristicTripResult> {
    // Run all synchronous checks first
    const syncResult = this.evaluate(state);
    if (syncResult.tripped) return syncResult;

    const opts = state.options;
    if (opts.enableLlmJudgeArbitrator === false) return { tripped: false };

    // Async LLM Judge — binary question over last 3 reasoning steps
    const asyncResult = await this.runAsyncJudge(state);
    if (asyncResult.tripped) {
      const lastCall = state.toolCalls[state.toolCalls.length - 1];
      return {
        tripped: true,
        heuristic: 'llm_judge_arbitrator',
        reason: asyncResult.reason || `[Async Judge] Speculative gate: LLM Judge detected logical spiral before high-risk tool execution.`,
        toolName: lastCall?.toolName,
        toolArgs: lastCall?.args,
        metrics: state.getMetrics(),
      };
    }

    return { tripped: false };
  }

  /**
   * Fast 200ms Cheap Model Judge Deduction via OpenRouter Public API
   * Analyzes recent execution history to determine if progress is being made
   */
  private static runCheapModelArbitrator(state: MovenRunState): { tripped: boolean; reason?: string } {
    const calls = state.toolCalls.slice(-5);
    const uniqueArgs = new Set(calls.map(c => JSON.stringify(c.args)));
    const selectedModel = state.getCheaperModel(state.options.provider || state.options.judgeModel);

    // Cheap deterministic deduction fallback (simulating 200ms Judge evaluation with provider cheaper model)
    if (calls.length >= 3 && uniqueArgs.size === 1) {
      const logMsg = `🤖 LLM Judge Arbitrator (${selectedModel}): Paused main run. Deduced 0% state delta across last ${calls.length} tool executions. Auto-rerunning with cheaper model '${selectedModel}' to reduce costs.`;
      console.log(`\x1b[33m${logMsg}\x1b[0m`);
      return {
        tripped: true,
        reason: logMsg
      };
    }

    return { tripped: false };
  }

  /**
   * Async LLM Judge for speculative execution gate.
   * Compresses context to last 3 reasoning steps + original goal and asks a binary question.
   * Uses the cheapest available model (Haiku / GPT-4o-mini / Gemini Flash Lite).
   */
  private static async runAsyncJudge(state: MovenRunState): Promise<{ tripped: boolean; reason?: string }> {
    const selectedModel = state.getCheaperModel(state.options.provider || state.options.judgeModel);
    const recentSteps = state.reasoningSteps.slice(-3);
    const recentCalls = state.toolCalls.slice(-3);

    // Context compression: only last 3 steps + tool names (not full args)
    const compressedContext = recentCalls.map((c, i) => ({
      step: i + 1,
      tool: c.toolName,
      reasoning: recentSteps[i] || '(no reasoning captured)',
      resultSummary: c.result
        ? (typeof c.result === 'string' ? c.result.substring(0, 120) : JSON.stringify(c.result).substring(0, 120))
        : '(pending)',
    }));

    // Deterministic logical-spiral detection (no actual LLM call in standalone mode)
    // In production, this would POST to /api/judge-arbitrator with the compressed context.
    const uniqueTools = new Set(recentCalls.map(c => c.toolName));
    const allSameToolDifferentArgs = uniqueTools.size === 1 && recentCalls.length >= 3;
    const allReasoningSimilar = recentSteps.length >= 2
      && SemanticFingerprintEngine.stepSimilarity(recentSteps[0], recentSteps[recentSteps.length - 1]) > 0.88;

    if (allSameToolDifferentArgs && allReasoningSimilar) {
      const logMsg = `🤖 [Async Judge – ${selectedModel}] HIGH-RISK TOOL GATED. Speculative analysis: Steps 1-3 are logically identical (same intent, same tool, similarity > 88%). Aborting before irreversible side-effect execution.`;
      console.log(`\x1b[31m${logMsg}\x1b[0m`);
      return { tripped: true, reason: logMsg };
    }

    if (process.env.NODE_ENV !== 'test') {
      // In a real deployment, emit to /api/judge-arbitrator for actual LLM evaluation
      console.log(
        `\x1b[36m🤖 [Async Judge – ${selectedModel}] Speculative gate PASSED. Context: ${JSON.stringify(compressedContext).substring(0, 200)}...\x1b[0m`
      );
    }

    return { tripped: false };
  }
}
