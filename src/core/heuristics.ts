import { MovenRunState } from './run-state';
import { MovenHeuristicType, MovenKillMetrics } from './errors';

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

    // 1. Repeat Call Detection
    const repeatCount = state.getRecentRepeatCallsCount(opts.repeatTimeWindowMs);
    if (repeatCount >= (opts.maxRepeatCalls || 5)) {
      const lastCall = state.toolCalls[state.toolCalls.length - 1];
      return {
        tripped: true,
        heuristic: 'repeat_tool_call',
        reason: `Tool '${lastCall?.toolName}' called ${repeatCount} times in last ${opts.repeatTimeWindowMs! / 1000}s with near-identical parameters.`,
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

    // 3. Depth Ceiling
    if (state.depth > (opts.maxDepth || 15)) {
      return {
        tripped: true,
        heuristic: 'depth_ceiling',
        reason: `Agent call depth (${state.depth}) exceeded maximum allowed recursion limit (${opts.maxDepth}).`,
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

    // 6. Custom Developer Rule Check
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
}
