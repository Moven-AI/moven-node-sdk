/**
 * Moven Verifier — policy regression testing for CI.
 *
 * Replays recorded tool-call sequences through the REAL heuristic engine in
 * dry-run mode (no tools execute, no telemetry leaves the process) and
 * reports where a candidate policy would trip. Wire it into CI:
 *
 *   const report = MovenVerifier.verify(recordedTraces, candidatePolicy);
 *   if (report.trippedTraces.length > 0) process.exit(1);
 *
 * Use it to answer "if I raise/lower this threshold, which of my recorded
 * golden traces would now be killed?" — the threshold regression check no
 * other circuit breaker offers.
 */

import { MovenRunState, MovenOptions } from './core/run-state';
import { MovenHeuristicsEngine, HeuristicTripResult } from './core/heuristics';

export interface RecordedToolCall {
  /** Tool name as called. */
  toolName: string;
  /** Arguments object (or JSON string). */
  args?: any;
  /** Result object (or JSON string) returned to the agent. */
  result?: any;
  /** Latency in ms (feeds the latency-hang breaker). */
  latencyMs?: number;
  /** Error flag — recorded as { error } result when true. */
  isError?: boolean;
  /** Optional reasoning text for this step. */
  reasoning?: string;
  /** Optional real token usage for this step. */
  promptTokens?: number;
  completionTokens?: number;
}

export interface RecordedTrace {
  /** Trace identifier for the report. */
  traceId?: string;
  /** Name of the source scenario (e.g. 'golden:weather-multi-city'). */
  name?: string;
  toolCalls: RecordedToolCall[];
}

export interface VerifyTraceReport {
  traceId?: string;
  name?: string;
  totalCalls: number;
  tripped: boolean;
  trip?: {
    atCall: number;
    heuristic?: string;
    reason?: string;
    toolName?: string;
  };
}

export interface VerifyReport {
  policySummary: Record<string, unknown>;
  traces: VerifyTraceReport[];
  trippedTraces: VerifyTraceReport[];
  cleanTraces: VerifyTraceReport[];
  totalCalls: number;
  /** true when every replay ran to completion without a trip. */
  passed: boolean;
  durationMs: number;
}

export class MovenVerifier {
  /**
   * Replay recorded traces against a candidate policy.
   *
   * @param traces   Recorded tool-call sequences (from golden tests, incident
   *                 exports, or hand-written regression cases).
   * @param policy   Candidate MovenOptions. `dryRun` is forced on internally —
   *                 nothing executes and nothing is reported.
   */
  public static verify(traces: RecordedTrace[], policy?: MovenOptions): VerifyReport {
    const start = Date.now();
    const effectivePolicy: MovenOptions = {
      // Never let a candidate policy egress telemetry or execute side effects
      apiKey: undefined,
      endpoint: 'http://127.0.0.1:1/invalid', // sinkhole
      enablePromptInjectionFirewall: policy?.enablePromptInjectionFirewall,
      ...policy,
      dryRun: true,
    };

    const reports: VerifyTraceReport[] = [];

    for (const trace of traces) {
      reports.push(this.verifyTrace(trace, effectivePolicy));
    }

    const trippedTraces = reports.filter(r => r.tripped);
    const cleanTraces = reports.filter(r => !r.tripped);

    return {
      policySummary: {
        maxRepeatCalls: effectivePolicy.maxRepeatCalls,
        maxCostDollar: effectivePolicy.maxCostDollar,
        maxDepth: effectivePolicy.maxDepth,
        maxNoProgressTurns: effectivePolicy.maxNoProgressTurns,
        maxErrorRatePct: effectivePolicy.maxErrorRatePct,
        maxSlowCallRatePct: effectivePolicy.maxSlowCallRatePct,
        semanticSimilarityThreshold: effectivePolicy.semanticFingerprint?.similarityThreshold,
        layer2Mode: effectivePolicy.layer2?.mode,
      },
      traces: reports,
      trippedTraces,
      cleanTraces,
      totalCalls: reports.reduce((acc, r) => acc + r.totalCalls, 0),
      passed: trippedTraces.length === 0,
      durationMs: Date.now() - start,
    };
  }

  /** Deep-copy helper — replay must NEVER mutate the caller's recorded traces. */
  private static cloneValue<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    try {
      if (typeof structuredClone === 'function') return structuredClone(value);
    } catch {
      /* fall through to JSON copy */
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }

  /** Replay a single trace. */
  public static verifyTrace(trace: RecordedTrace, policy?: MovenOptions): VerifyTraceReport {
    const effectivePolicy: MovenOptions = { ...(policy || {}), dryRun: true };
    const state = new MovenRunState(effectivePolicy);

    const report: VerifyTraceReport = {
      traceId: trace.traceId,
      name: trace.name,
      totalCalls: trace.toolCalls.length,
      tripped: false,
    };

    for (let i = 0; i < trace.toolCalls.length; i++) {
      const call = trace.toolCalls[i];

      if (call.reasoning) state.recordReasoning(call.reasoning);

      // Deep-clone args/results: recordToolCall injects an idempotency key
      // into the args object it is given — without cloning, a second replay
      // of the same trace would see polluted arguments and produce
      // different hashes than a first replay. Verifier output must be a
      // pure function of (trace, policy).
      const log = state.recordToolCall(call.toolName, this.cloneValue(call.args));

      const result = call.isError ? { error: 'recorded_error' } : this.cloneValue(call.result);
      state.recordToolResult(log, result, call.latencyMs ?? 100);

      if (call.promptTokens !== undefined) {
        state.recordStepTokens(call.promptTokens, call.completionTokens ?? 0);
      }

      let trip: HeuristicTripResult = { tripped: false };
      try {
        trip = MovenHeuristicsEngine.evaluate(state);
      } catch (err) {
        trip = {
          tripped: true,
          heuristic: 'custom_rule',
          reason: `Verifier evaluation error: ${(err as Error)?.message || err}`,
        };
      }

      if (trip.tripped) {
        report.tripped = true;
        report.trip = {
          atCall: i + 1,
          heuristic: trip.heuristic,
          reason: trip.reason,
          toolName: trip.toolName || call.toolName,
        };
        break;
      }
    }

    return report;
  }

  /**
   * Format a report as a CI-friendly multi-line string.
   */
  public static formatReport(report: VerifyReport): string {
    const lines: string[] = [];
    lines.push('🧪 Moven Verify — Policy Regression Report');
    lines.push(`   Policy: ${JSON.stringify(report.policySummary)}`);
    lines.push(`   Traces: ${report.traces.length} replayed | ${report.cleanTraces.length} clean | ${report.trippedTraces.length} would trip | ${report.totalCalls} calls in ${report.durationMs}ms`);

    if (report.trippedTraces.length > 0) {
      lines.push('');
      lines.push('   ❌ TRIPPED under candidate policy:');
      for (const t of report.trippedTraces) {
        const label = t.name || t.traceId || 'unnamed-trace';
        lines.push(`      • ${label} — tripped at call #${t.trip?.atCall} (${t.trip?.toolName}) [${t.trip?.heuristic}]`);
        lines.push(`        ${t.trip?.reason}`);
      }
      lines.push('');
      lines.push('   CI: FAIL — candidate policy kills known-good traces.');
    } else {
      lines.push('   ✅ CI: PASS — all recorded traces survive the candidate policy.');
    }

    return lines.join('\n');
  }
}
