import { MovenRunState } from './run-state';
import { MovenHeuristicType, MovenKillMetrics } from './errors';
import { MovenOvernightBurnGuard } from './burn-guard';
import { MovenHallucinationDetector } from './hallucination';
import { SemanticFingerprintEngine } from './semantic-fingerprint';
import { MovenAdaptiveLoopEngine } from './adaptive-loop';
import { MovenPromptInjectionFirewall } from './prompt-firewall';
import { MovenLogger } from './logger';

export interface HeuristicTripResult {
  tripped: boolean;
  heuristic?: MovenHeuristicType;
  reason?: string;
  toolName?: string;
  toolArgs?: any;
  metrics?: MovenKillMetrics;
}

/**
 * Enterprise fail-safe: a crashing sub-detector (bad args, exotic payloads,
 * engine bug) must NEVER take down the guarded tool call. The detector is
 * treated as "did not trip" and the internal error is logged — the hard
 * deterministic ceilings (cost / depth) still run afterwards unconditionally.
 */
function failSafe<T>(detectorName: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err: any) {
    MovenLogger.error(
      `Circuit breaker sub-detector '${detectorName}' threw an internal error and was skipped (fail-open). Hard ceilings remain active.`,
      { detector: detectorName, error: err?.message || String(err) }
    );
    return fallback;
  }
}

export class MovenHeuristicsEngine {
  public static evaluate(state: MovenRunState): HeuristicTripResult {
    const opts = state.options;

    // After an auto-fallback switch, the engine grants a short grace window
    // (state.fallbackGraceSteps, consumed one step per recordToolCall) during
    // which LOOP-DETECTION heuristics are suppressed so the cheaper model gets
    // a fair chance to make progress. Hard limits below (burn guard, cost,
    // depth, firewall, hallucination, SRE checks) ALWAYS run.
    const inGrace = state.fallbackGraceSteps > 0;

    // 0. Overnight Burn Guard ($2000 Loss Prevention Engine Check)
    const burnGuardResult = failSafe('burn_guard', () => MovenOvernightBurnGuard.evaluate(state), { tripped: false });
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
    const hallucinationResult = failSafe('hallucination', () => MovenHallucinationDetector.evaluate(state), { tripped: false });
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

    // 0.6. Real-Time Prompt Injection & Jailbreak Firewall Check
    if (opts.enablePromptInjectionFirewall !== false) {
      const firewallConfig = opts.promptFirewall || {};

      // 0.6a. Inspect user prompt / goal (runs on every evaluation, even before tool calls)
      if (!state._userPromptScanned) {
        const userInput = opts.userRequest || opts.goal || opts.userPrompt;
        if (userInput) {
          const promptInspection = failSafe(
            'firewall_user_prompt',
            () => MovenPromptInjectionFirewall.inspect(userInput, firewallConfig),
            { isAttack: false, confidence: 0 } as any
          );
          if (promptInspection.isAttack) {
            return {
              tripped: true,
              heuristic: 'prompt_injection',
              reason: promptInspection.reason || `[Prompt Injection Firewall] Malicious attack in user prompt (${promptInspection.attackType})`,
              toolName: '__user_prompt__',
              toolArgs: { userInput: typeof userInput === 'string' ? userInput.substring(0, 200) : userInput },
              metrics: state.getMetrics(),
            };
          }
          state._userPromptScanned = true;
        }
      }

      // 0.6b. Inspect latest tool call arguments & reasoning (original behavior)
      if (state.toolCalls.length > 0) {
        const lastCall = state.toolCalls[state.toolCalls.length - 1];
        const inspection = failSafe(
          'firewall_tool_args',
          () => MovenPromptInjectionFirewall.inspect(
            { args: lastCall.args, reasoning: lastCall.reasoning },
            firewallConfig
          ),
          { isAttack: false, confidence: 0 } as any
        );
        if (inspection.isAttack) {
          return {
            tripped: true,
            heuristic: 'prompt_injection',
            reason: inspection.reason || `[Prompt Injection Firewall] Malicious attack pattern intercepted (${inspection.attackType})`,
            toolName: lastCall.toolName,
            toolArgs: lastCall.args,
            metrics: state.getMetrics(),
          };
        }
      }
    }

    // 0.7. Deterministic Hard Ceilings (Immediate Trip on Hard Limit Violations)
    // 0.7a. Depth Ceiling (with Adaptive 95th-Percentile Baseline)
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

    // 0.7b. Cost Ceiling — HARD by default. The PRD promise is "hard dollar
    // ceilings": the cap trips exactly at maxCostDollar. Opt-in soft mode
    // (softCostCeiling: true) grants 25% headroom while the run is
    // demonstrably making progress (recent state hashes all distinct).
    if (state.cumulativeCost >= (opts.maxCostDollar || 2.00)) {
      let effectiveCap = opts.maxCostDollar || 2.00;
      if (opts.softCostCeiling === true) {
        const recentHashes = state.stateHashes.slice(-3);
        const isMakingProgress = recentHashes.length >= 2 && new Set(recentHashes).size === recentHashes.length;
        if (isMakingProgress) effectiveCap = effectiveCap * 1.25;
      }
      if (state.cumulativeCost >= effectiveCap) {
        return {
          tripped: true,
          heuristic: 'cost_ceiling',
          reason: `Cumulative token cost ($${state.cumulativeCost.toFixed(4)}) exceeded ${opts.softCostCeiling ? 'soft' : 'hard'} cost ceiling ($${effectiveCap.toFixed(2)}).`,
          metrics: state.getMetrics(),
        };
      }
    }

    // ─── USER-INTENT ATTESTATION ─────────────────────────────────────────
    // When the call currently being judged follows a fresh human instruction
    // ("search it 5 times"), pure repetition is EXPECTED behavior, not a
    // runaway loop. Loop heuristics are relaxed for those calls; the only
    // breaker that still fires is the stagnation ceiling — N consecutive
    // attested calls returning byte-identical results is waste regardless
    // of who asked. Hard limits (cost / depth / burn guard / SRE) below
    // always run.
    const lastToolCall = state.toolCalls.length > 0 ? state.toolCalls[state.toolCalls.length - 1] : undefined;
    const userDirected = Boolean(lastToolCall?.humanAttested);
    if (userDirected && lastToolCall) {
      const refHash = lastToolCall.resultHash;
      let stagnantAttested = 0;
      for (let i = state.toolCalls.length - 1; i >= 0; i--) {
        const c = state.toolCalls[i];
        if (!c.humanAttested) break;
        if (c.resultHash && refHash && c.resultHash === refHash) stagnantAttested += 1;
        else break;
      }
      // Budget hierarchy: an EXPLICIT user count ("search it 5 times") sets
      // the allowance exactly (trip AFTER the stated count is exhausted);
      // otherwise the general waste backstop applies.
      const attestation = state.getActiveAttestation?.();
      const hardCeiling = opts.maxHumanAttestedStagnantSteps || 12;
      const allowance = attestation?.repetitionAllowance;
      if (allowance && allowance > 0) {
        if (stagnantAttested > allowance) {
          return {
            tripped: true,
            heuristic: 'user_directed_ceiling',
            reason: `User asked for ${allowance} repetitions of '${lastToolCall.toolName}' — that budget is now exhausted (${stagnantAttested} identical results). Stopping to protect spend.`,
            toolName: lastToolCall.toolName,
            toolArgs: lastToolCall.args,
            metrics: state.getMetrics(),
          };
        }
      } else if (stagnantAttested >= hardCeiling) {
        return {
          tripped: true,
          heuristic: 'user_directed_ceiling',
          reason: `Human-directed loop exceeded stagnation ceiling: '${lastToolCall.toolName}' returned an identical result ${stagnantAttested} consecutive times. Even user-requested repetition stops being productive here.`,
          toolName: lastToolCall.toolName,
          toolArgs: lastToolCall.args,
          metrics: state.getMetrics(),
        };
      }
    }

    if (!inGrace && !userDirected) {
      // 0.8. Semantic Fingerprint Layer (<1ms, zero-AI, catches smart loops that hash-based
      //      checks miss: goal-state hash repeat, cosine similarity collapse, entropy stagnation)
      // The goal-state hash sub-check is exempted while the last call is an
      // actively-progressing poll — a legitimate poll returning the same
      // status twice must NOT look like a semantic loop.
      if (
        opts.enableSemanticFingerprint !== false &&
        opts.semanticFingerprint?.enabled !== false &&
        state.reasoningSteps.length >= 3
      ) {
        let skipGoalStateHash = false;
        if (state.toolCalls.length > 0) {
          const lastCall = state.toolCalls[state.toolCalls.length - 1];
          if (lastCall.isPollingTool) {
            const ttlSec = opts.pollingTtlSeconds || 600;
            const firstPoll = state.toolCalls.find(c => c.toolName === lastCall.toolName && c.argsHash === lastCall.argsHash);
            const withinTtl = firstPoll ? (Date.now() - firstPoll.timestamp) / 1000 <= ttlSec : false;
            skipGoalStateHash = lastCall.isResultProgressive === true || withinTtl;
          }
        }
        const sfResult = failSafe(
          'semantic_fingerprint',
          () => SemanticFingerprintEngine.evaluate(
            state.reasoningSteps,
            state.intentHashes,
            opts.semanticFingerprint,
            { skipGoalStateHash },
          ),
          { tripped: false } as any
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

      // 0.9. Layer 2: Semantic Guard (<0.8ms in-process hot path, tiny multi-head classifier)
      if (opts.layer2?.enabled !== false && state.toolCalls.length > 0 && state.layer2Guard) {
        const lastCall = state.toolCalls[state.toolCalls.length - 1];
        const l2Result = failSafe(
          'layer2_semantic_guard',
          () => state.layer2Guard.evaluate(
            lastCall.toolName,
            lastCall.args,
            state.userRequest
          ),
          { decision: 'ALLOW', reason: 'Layer 2 guard internal error — fail-open.' } as any
        );
        state.lastLayer2Result = l2Result;

        if (l2Result.decision === 'BLOCK' || l2Result.decision === 'REPLAN') {
          return {
            tripped: true,
            heuristic: l2Result.decision === 'BLOCK' ? 'layer2_block' : 'layer2_replan',
            reason: l2Result.reason,
            toolName: lastCall.toolName,
            toolArgs: lastCall.args,
            metrics: state.getMetrics(),
          };
        }
      }

      // 1. Advanced Adaptive Loop Engine (Novelty Scoring, Jaccard Divergence, Cycle Oscillation, Discovery Headroom)
      if (state.toolCalls.length > 0) {
        const adaptiveResult = failSafe(
          'adaptive_loop',
          () => MovenAdaptiveLoopEngine.evaluate(state.toolCalls, opts.maxRepeatCalls ? Math.max(opts.maxRepeatCalls * 3, 15) : 15),
          { tripped: false, category: 'COMPUTATIONAL', noveltyScore: 1, entropyGain: 1, consecutiveCount: 0, isLegitimateExploration: true }
        );
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

      // 1.6. PRE-TRIP WARNING ZONE — give the MODEL one turn to self-correct
      // before the breaker kills the run. When a pattern is one call away
      // from tripping, push a warning onto the run state; the LangGraph /
      // Vercel model wrappers inject it into the next model invocation.
      if (opts.warnBeforeTrip !== false && repeatCount === effectiveRepeatLimit - 1 && lastCall) {
        state.pushWarning({
          heuristic: 'repeat_tool_call',
          toolName: lastCall.toolName,
          argsHash: lastCall.argsHash,
          remaining: 1,
          message: `You have called the tool '${lastCall.toolName}' ${repeatCount} times with near-identical arguments and no state progression. The Moven circuit breaker will HALT execution if you call it again without changing your approach. Either vary the arguments meaningfully, use a different tool, or summarize what you have and move on.`,
        });
      }

      // 4. No-Progress Detection (consecutive identical turn state hashes)
      const hashes = state.stateHashes;
      const maxNoProgress = opts.maxNoProgressTurns || 3;
      if (hashes.length >= maxNoProgress) {
        const recentHashes = hashes.slice(-maxNoProgress);
        const allIdentical = recentHashes.every(h => h === recentHashes[0]);
        if (allIdentical) {
          const lastCall2 = state.toolCalls[state.toolCalls.length - 1];
          return {
            tripped: true,
            heuristic: 'no_progress_loop',
            reason: `No-progress loop detected: output state hash repeated ${maxNoProgress} consecutive times without progress.`,
            toolName: lastCall2?.toolName,
            toolArgs: lastCall2?.args,
            metrics: state.getMetrics(),
          };
        }
      } else if (opts.warnBeforeTrip !== false && hashes.length === maxNoProgress - 1 && hashes.length > 0) {
        const recentHashes = hashes.slice(-(maxNoProgress - 1));
        if (recentHashes.every(h => h === recentHashes[0])) {
          const lastCall2 = state.toolCalls[state.toolCalls.length - 1];
          if (lastCall2) {
            state.pushWarning({
              heuristic: 'no_progress_loop',
              toolName: lastCall2.toolName,
              argsHash: lastCall2.argsHash,
              remaining: 1,
              message: `Your last ${recentHashes.length} turns produced identical output with no progress. The Moven circuit breaker will HALT execution if the next turn shows no progress again. Re-plan: try a different tool, change parameters, or report partial results.`,
            });
          }
        }
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
      const lastCall2 = state.toolCalls[state.toolCalls.length - 1];
      return {
        tripped: true,
        heuristic: 'schema_validation_failure',
        reason: `Output schema validation failed ${state.consecutiveSchemaFailures} consecutive times. Opened circuit breaker to prevent agent from processing corrupted data.`,
        toolName: lastCall2?.toolName,
        toolArgs: lastCall2?.args,
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

    // 11. Custom Developer Rule Check (fail-safe: a throwing custom rule is
    // logged and skipped — it can never crash the guarded tool execution)
    if (opts.customCheck) {
      const customRes = failSafe('custom_check', () => opts.customCheck!(state), null as any);
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
}
