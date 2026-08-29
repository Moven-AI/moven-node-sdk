import { MovenKillError, MovenPauseError } from '../core/errors';
import { HeuristicTripResult } from '../core/heuristics';
import { MovenRunState } from '../core/run-state';
import { MovenReporter } from '../reporter';
import { MovenDynamicPricingEngine } from '../core/pricing';
import { safeStringify } from '../core/safe-json';
import { recordDecisionSpan } from '../otel';
import { MovenLogger } from '../core/logger';

export class MovenKillHandler {
  /**
   * Grace steps granted to a cheaper model after an auto-fallback switch.
   * Loop-detection heuristics are suppressed for this many tool calls while
   * hard limits (cost / depth / burn guard / firewall / SRE) stay active.
   */
  private static readonly FALLBACK_GRACE_STEPS = 3;

  private static emitDecisionSpan(
    decision: 'DRY_RUN' | 'PAUSE' | 'FALLBACK' | 'KILL',
    tripResult: HeuristicTripResult,
    state: MovenRunState
  ): void {
    recordDecisionSpan({
      decision,
      heuristic: tripResult.heuristic,
      reason: tripResult.reason,
      toolName: tripResult.toolName,
      runId: state.runId,
      agentId: state.agentId,
      agentName: state.agentName,
      cost: state.cumulativeCost,
      error: decision === 'KILL',
    });
  }

  /**
   * Handles a heuristic trip result by checking dry-run mode, soft pause, auto-fallback, or throwing MovenKillError.
   */
  public static async handleTripResult(
    tripResult: HeuristicTripResult,
    state: MovenRunState,
    reporter?: MovenReporter
  ): Promise<{ fallbackActivated: boolean; dryRunTrip?: boolean; paused?: boolean }> {
    if (!tripResult.tripped) return { fallbackActivated: false };

    this.emitDecisionSpan('DRY_RUN', tripResult, state);

    // 1. Dry Run Simulation Mode Check
    if (state.options.dryRun) {
      MovenLogger.warn(
        `[DRY RUN MODE] Circuit breaker simulated trip for heuristic '${tripResult.heuristic || 'repeat_tool_call'}': ${tripResult.reason}. Execution continues without interruption.`,
        { runId: state.runId, dryRun: true }
      );

      if (reporter) {
        reporter.sendPayload({
          event: 'dry_run_trip',
          runId: state.runId,
          agentId: state.agentId,
          agentName: state.agentName,
          heuristic: tripResult.heuristic,
          reason: tripResult.reason,
          toolName: tripResult.toolName,
          toolArgs: tripResult.toolArgs,
          metrics: tripResult.metrics || state.getMetrics(),
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }

      return { fallbackActivated: false, dryRunTrip: true };
    }

    // 2. Human-in-the-Loop Soft Trip / Pause & Ask
    // The pause is ENFORCED, not advisory: the run is marked halted (the
    // interception guard blocks every subsequent tool call) and a
    // MovenPauseError is thrown so the in-flight call cannot proceed either.
    // The operator resolves the halt via MovenRewindEngine.resolve().
    if (state.options.pauseOnTrip) {
      this.emitDecisionSpan('PAUSE', tripResult, state);
      const resumeToken = `resume_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      MovenLogger.warn(
        `[PAUSE & ASK] Agent '${state.agentName}' paused on suspicious activity for developer verification. Webhook dispatched.`,
        { runId: state.runId, resumeToken }
      );

      // Halt FIRST so nothing can execute between notification and throw.
      state.halted = true;
      state.haltReason = `Paused for human review (pauseOnTrip): ${tripResult.reason || 'suspicious loop detected'}`;

      if (reporter) {
        reporter.sendPayload({
          event: 'pause',
          runId: state.runId,
          agentId: state.agentId,
          agentName: state.agentName,
          heuristic: tripResult.heuristic,
          reason: tripResult.reason,
          toolName: tripResult.toolName,
          toolArgs: tripResult.toolArgs,
          resumeToken,
          metrics: tripResult.metrics || state.getMetrics(),
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }

      if (state.options.onPause) {
        try {
          state.options.onPause({
            agentName: state.agentName,
            reason: tripResult.reason || 'Paused on suspicious loop',
            toolName: tripResult.toolName,
            args: tripResult.toolArgs,
            resumeToken,
          });
        } catch {}
      }

      throw new MovenPauseError({
        runId: state.runId,
        reason: state.haltReason,
        heuristic: tripResult.heuristic,
        toolName: tripResult.toolName,
        toolArgs: tripResult.toolArgs,
        resumeToken,
        metrics: tripResult.metrics || state.getMetrics(),
      });
    }

    // 3. Auto-fallback: switch to cheaper model on first trip instead of killing (NEVER bypass for security/prompt-injections)
    // HALT GATE: a halted agent (post-rewind) must NEVER auto-resume into the same loop —
    // that is how incident #2 happens ten seconds later. Fallback is skipped and the kill path halts.
    if (state.options.autoFallbackCheaperModel && !state.isFallbackActive && !state.halted && tripResult.heuristic !== 'prompt_injection') {
      this.emitDecisionSpan('FALLBACK', tripResult, state);
      const cheaperModel = state.switchToCheaperModel();
      MovenLogger.warn(
        `[Auto-Fallback Activated] Routing agent '${state.agentName}' to cheaper model '${cheaperModel}' instead of terminating run.`,
        { runId: state.runId, cheaperModel }
      );

      // Report fallback event asynchronously to dashboard and webhooks
      if (reporter) {
        const killError = new MovenKillError({
          runId: state.runId,
          heuristic: tripResult.heuristic || 'repeat_tool_call',
          reason: `[Auto-Fallback to ${cheaperModel}] ${tripResult.reason || 'Circuit breaker tripped'}`,
          toolName: tripResult.toolName,
          toolArgs: tripResult.toolArgs,
          metrics: tripResult.metrics || state.getMetrics(),
        });
        reporter.reportKillEvent(killError, state).catch(() => {});
      }

      if (state.options.onHallucination) {
        try {
          state.options.onHallucination({
            agentName: state.agentName,
            reason: tripResult.reason || 'Agent loop detected (fallback activated)',
            toolName: tripResult.toolName,
            args: tripResult.toolArgs,
          });
        } catch {}
      }

      // Preserve the FULL execution history (evidence for the dashboard) and
      // the Ctrl+Z checkpoint ledger — wiping them destroyed forensic value
      // and broke future rewinds. Instead, grant the cheaper model a short
      // grace window: loop-detection heuristics are suppressed for the next
      // N tool calls while hard limits stay enforced. If the loop persists
      // after grace, the next trip kills the run (isFallbackActive=true).
      state.fallbackGraceSteps = MovenKillHandler.FALLBACK_GRACE_STEPS;
      return { fallbackActivated: true };
    }

    // Already in fallback mode or auto-fallback disabled — execute kill
    this.emitDecisionSpan('KILL', tripResult, state);
    await this.executeKill(tripResult, state, reporter);
    return { fallbackActivated: false };
  }

  public static async executeKill(
    tripResult: HeuristicTripResult,
    state: MovenRunState,
    reporter?: MovenReporter
  ): Promise<never> {
    state.isKilled = true;
    // HALT GATE: killing halts the agent. No tool call passes the interception
    // guard again until an operator resumes / re-plans, and the offending tool
    // goes on a cooldown so it cannot retrigger the identical loop.
    state.halted = true;
    state.haltReason = state.haltReason || tripResult.reason || 'Circuit breaker tripped — awaiting operator review before resume.';

    // SINGLE-FLIGHT KILL: concurrent tool executions can both trip the breaker
    // in the same tick. Side effects (banner, callbacks, cooldown, kill event)
    // run exactly once; duplicate callers still receive their own kill error.
    if (state.markKillInitiated()) {
      if (tripResult.toolName) {
        const cooldownSeconds = state.options.rewindCooldownSeconds ?? 300;
        state.applyCooldown(tripResult.toolName, cooldownSeconds);
      }
      this.runKillSideEffects(tripResult, state, reporter);
    } else {
      MovenLogger.debug('Duplicate kill suppressed (single-flight guard).', { runId: state.runId, toolName: tripResult.toolName });
    }

    // Throw catchable error (every concurrent caller must observe the kill)
    const error = new MovenKillError({
      runId: state.runId,
      heuristic: tripResult.heuristic || 'repeat_tool_call',
      reason: tripResult.reason || 'Circuit breaker tripped',
      toolName: tripResult.toolName,
      toolArgs: tripResult.toolArgs,
      metrics: tripResult.metrics || state.getMetrics(),
    });
    throw error;
  }

  private static runKillSideEffects(
    tripResult: HeuristicTripResult,
    state: MovenRunState,
    reporter?: MovenReporter
  ): void {
    const error = new MovenKillError({
      runId: state.runId,
      heuristic: tripResult.heuristic || 'repeat_tool_call',
      reason: tripResult.reason || 'Circuit breaker tripped',
      toolName: tripResult.toolName,
      toolArgs: tripResult.toolArgs,
      metrics: tripResult.metrics || state.getMetrics(),
    });

    // Print vibrant, high-visibility ANSI color banner to terminal (suppressed
    // when the log level is 'silent' or a JSON pipeline is configured).
    if (MovenLogger.isEnabled('error')) {
      console.error(`\n\x1b[41m\x1b[30m\x1b[1m ⚡ MOVEN AI CIRCUIT BREAKER TRIPPED! ⚡ \x1b[0m`);
      console.error(`\x1b[31m\x1b[1m🛑 AGENT:\x1b[0m \x1b[33m\x1b[1m${state.agentName}\x1b[0m`);
      console.error(`\x1b[31m\x1b[1m🛑 HEURISTIC:\x1b[0m \x1b[36m${tripResult.heuristic || 'repeat_tool_call'}\x1b[0m`);
      console.error(`\x1b[31m\x1b[1m🛑 REASON:\x1b[0m ${tripResult.reason}`);
      if (tripResult.toolName) {
        console.error(`\x1b[31m\x1b[1m🛠️  OFFENDING TOOL:\x1b[0m \x1b[35m${tripResult.toolName}\x1b[0m`);
        console.error(`\x1b[31m\x1b[1m📋 ARGUMENTS:\x1b[0m \x1b[90m${safeStringify(tripResult.toolArgs || {})}\x1b[0m`);
      }
    }

    const metrics = tripResult.metrics || state.getMetrics();
    const activeModel = state.options.currentModel || state.getCheaperModel() || 'openai/gpt-4o-mini';

    const calc = MovenDynamicPricingEngine.calculateMoneySaved({
      modelName: activeModel,
      totalToolCallsMade: metrics.totalToolCalls,
      actualCostSpent: metrics.totalCost,
      actualPromptTokensSpent: metrics.promptTokens ?? state.cumulativePromptTokens,
      actualCompletionTokensSpent: metrics.completionTokens ?? state.cumulativeCompletionTokens,
      customPromptRatePerMillion: state.options.promptCostPerMillion,
      customCompletionRatePerMillion: state.options.completionCostPerMillion,
    });

    const moneySaved = calc.moneySaved;
    const promptPerMillion = calc.promptPerMillion;
    const completionPerMillion = calc.completionPerMillion;
    const totalPreventedTokens = calc.totalPreventedTokens;
    const preventedRunawaySteps = calc.preventedRunawaySteps;
    const actualCost = metrics.totalCost || 0;

    MovenLogger.error(
      `CIRCUIT BREAKER TRIPPED — agent '${state.agentName}' killed. Money saved: $${moneySaved >= 0.01 ? moneySaved.toFixed(2) : moneySaved.toFixed(4)}`,
      {
        runId: state.runId,
        agentName: state.agentName,
        heuristic: tripResult.heuristic || 'repeat_tool_call',
        reason: tripResult.reason,
        toolName: tripResult.toolName,
        model: activeModel,
        rates: `$${promptPerMillion}/1M in, $${completionPerMillion}/1M out`,
        math: `${preventedRunawaySteps} runaway turns prevented (${totalPreventedTokens.toLocaleString()} tokens prevented) - $${actualCost.toFixed(4)} spent`,
      }
    );

    // Notify user-provided callbacks if present
    if (state.options.onHallucination) {
      try {
        state.options.onHallucination({
          agentName: state.agentName,
          reason: tripResult.reason || 'Agent hallucination or infinite loop detected',
          toolName: tripResult.toolName,
          args: tripResult.toolArgs,
        });
      } catch (err) {
        MovenLogger.error('Error inside onHallucination callback:', { error: (err as any)?.message || String(err) });
      }
    }

    if (state.options.onKill) {
      try {
        state.options.onKill(error);
      } catch (err) {
        MovenLogger.error('Error inside onKill callback:', { error: (err as any)?.message || String(err) });
      }
    }

    // Report event asynchronously to hosted backend
    if (reporter) {
      reporter.reportKillEvent(error, state).catch(err => {
        MovenLogger.warn('Failed to report kill event:', { error: err?.message || String(err) });
      });
    }
  }

  public static createStreamAbortSignal(
    state: MovenRunState,
    reporter?: MovenReporter
  ): { signal: AbortSignal; abort: (reason: string) => void } {
    const controller = new AbortController();

    const abort = (reason: string) => {
      const firstKill = state.markKillInitiated();
      state.isKilled = true;
      state.halted = true;
      state.haltReason = `Stream aborted: ${reason}`;
      controller.abort(reason);
      if (reporter && firstKill) {
        const error = new MovenKillError({
          runId: state.runId,
          heuristic: 'repeat_tool_call',
          reason: `Stream aborted: ${reason}`,
          metrics: state.getMetrics(),
        });
        reporter.reportKillEvent(error, state).catch(() => {});
      }
    };

    return { signal: controller.signal, abort };
  }
}
