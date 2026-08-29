// ─────────────────────────────────────────────────────────────────────────────
// Moven Rewind Engine — the honest rewind.
//
// Guarantees:
//  1. RESTORES in-process orchestration state only (context, scratchpad,
//     retry counts, conversation pointer). Always safe — pure memory.
//  2. CANCELS anything queued / in-flight that has not committed yet.
//  3. For each call that DID commit since the checkpoint: runs the registered
//     compensating action (saga), or lists it explicitly as
//     "executed, not reversed" for manual review. Never pretends.
//  4. Returns a RECEIPT (not a toast): N fully reversed, M never executed,
//     K needing manual review — with the explicit list.
//  5. HALTS. No auto-resume into the same loop. The offending tool goes on a
//     cooldown so it cannot retrigger the identical loop immediately.
// ─────────────────────────────────────────────────────────────────────────────

import type { MovenRunState } from './run-state';
import type { AgentCheckpointState, CompensationEntry } from './checkpoint';
import type { MovenReporter } from '../reporter';
import { recordRewindSpan, MovenOtelExporter } from '../otel';

export type RewindOutcome = 'reversed' | 'never_executed' | 'manual_review';

export interface RewindCallOutcome {
  toolName: string;
  argsHash?: string;
  args?: any;
  outcome: RewindOutcome;
  /** true if the call reached the downstream API before the trip */
  committed: boolean;
  compensationRegistered: boolean;
  compensationName?: string;
  compensationOk?: boolean;
  compensationError?: string;
  detail: string;
  executedAt?: string;
}

export interface RewindReceipt {
  receiptId: string;
  runId: string;
  traceId: string;
  agentName: string;
  checkpoint: { key: string; stepIndex: number; turnNumber?: number };
  /** Mechanism 1 — what was restored (in-process only, always safe) */
  restored: {
    context: boolean;
    scratchpad: boolean;
    retryCounts: boolean;
    conversationPointer: boolean;
    truncatedCalls: number;
  };
  /** Mechanism 2a — cancelled before they could commit */
  cancelledQueued: number;
  cancelledCalls: { toolName: string; argsHash?: string; previousStatus: string }[];
  /** Mechanism 2b — saga results for committed calls */
  fullyReversed: number;
  neverExecuted: number;
  needsManualReview: RewindCallOutcome[];
  /** Full per-call ledger */
  outcomes: RewindCallOutcome[];
  /** Mechanism 2c — idempotency keys were attached to every wrapped call */
  idempotencyGuaranteed: boolean;
  /** Halt semantics */
  halted: true;
  haltReason: string;
  offendingTool?: string;
  cooldownUntil: number;
  cooldownSeconds: number;
  decision: 'awaiting_decision';
  durationMs: number;
}

export interface RewindOptions {
  /** Rewind target: checkpoint key ('ckpt_turn_2') or step index. Default: latest checkpoint. */
  checkpointKey?: string;
  checkpointStep?: number;
  /** Cooldown applied to the offending tool (default 300s) */
  cooldownSeconds?: number;
  /** Scope the cooldown to the tool (default) or to tool+args */
  cooldownScope?: 'tool' | 'tool_args';
  /** Timeout per compensating handler (default 5000ms) */
  compensationTimeoutMs?: number;
  /** Explicit offending tool (e.g. from the breaker trip). Overrides the inferred loop head. */
  offendingTool?: string;
  /** Fire-and-forget report of the receipt to api.moven.dev */
  report?: boolean;
  triggeredBy?: 'operator' | 'sdk' | 'auto';
}

function withTimeout<T>(p: Promise<T> | any, ms: number): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Compensation timed out after ${ms}ms`)), ms)),
  ]);
}

export class MovenRewindEngine {
  /**
   * Executes a full rewind and returns a receipt. Never throws for expected
   * cases — manual-review items are data, not errors.
   */
  public static async rewind(
    state: MovenRunState,
    reporter: MovenReporter | undefined,
    options: RewindOptions = {}
  ): Promise<RewindReceipt | null> {
    const start = Date.now();
    const manager = state.checkpointManager;
    const checkpoints = manager.getCheckpoints();
    if (checkpoints.length === 0) return null;

    // ── 1. Resolve the target checkpoint ──────────────────────────────────
    let target: AgentCheckpointState | null = null;
    if (options.checkpointKey) {
      target = manager.getCheckpointByKey(options.checkpointKey);
    } else if (options.checkpointStep !== undefined) {
      target = checkpoints.find(c => c.stepIndex === options.checkpointStep) || null;
    } else {
      target = manager.getLatest();
    }
    if (!target) return null;

    // Calls made at/after the target checkpoint's step are the ones the rewind
    // is responsible for. Checkpoint S is captured immediately BEFORE call S
    // executes, so "since checkpoint" = depth >= S (timestamp fallback for
    // legacy logs without depth).
    const callsSinceCheckpoint = state.toolCalls.filter(
      c => (c.depth !== undefined ? c.depth >= target!.stepIndex : c.timestamp > target!.timestamp)
    );
    const committedCalls = callsSinceCheckpoint.filter(c => c.status === 'committed');
    const uncommittedCalls = callsSinceCheckpoint.filter(c => c.status === 'queued' || c.status === 'in_flight');

    const outcomes: RewindCallOutcome[] = [];
    const compensationTimeout = options.compensationTimeoutMs ?? 5000;

    // ── 2. Cancel anything queued / in-flight that hasn't committed ───────
    const cancelled = uncommittedCalls.map(c => {
      const previousStatus = c.status; // capture BEFORE mutating
      c.status = 'cancelled';
      outcomes.push({
        toolName: c.toolName,
        argsHash: c.argsHash,
        args: c.args,
        outcome: 'never_executed',
        committed: false,
        compensationRegistered: false,
        detail: 'Queued/in-flight when the loop was intercepted — cancelled before execution. Nothing to undo.',
      });
      return { toolName: c.toolName, argsHash: c.argsHash, previousStatus };
    });

    // ── 3. Saga: compensating actions for every call that committed ───────
    for (const call of committedCalls) {
      const comp: CompensationEntry | undefined = state.compensations.get(call.toolName);
      if (comp && comp.type === 'handler' && typeof comp.fn === 'function') {
        try {
          await withTimeout(comp.fn(call.args, call.result), comp.timeoutMs ?? compensationTimeout);
          outcomes.push({
            toolName: call.toolName,
            argsHash: call.argsHash,
            args: call.args,
            outcome: 'reversed',
            committed: true,
            compensationRegistered: true,
            compensationName: comp.name,
            compensationOk: true,
            detail: `Committed before the trip — reversed via registered compensating action '${comp.name}'.`,
            executedAt: new Date(call.timestamp).toISOString(),
          });
        } catch (err: any) {
          outcomes.push({
            toolName: call.toolName,
            argsHash: call.argsHash,
            args: call.args,
            outcome: 'manual_review',
            committed: true,
            compensationRegistered: true,
            compensationName: comp.name,
            compensationOk: false,
            compensationError: err?.message || String(err),
            detail: `Compensating action '${comp.name}' FAILED — call is committed externally and NOT reversed. Manual reconciliation required.`,
            executedAt: new Date(call.timestamp).toISOString(),
          });
        }
      } else if (comp && (comp.type === 'api_call' || comp.type === 'manual')) {
        // Declarative/manual entries never auto-execute from the receipt path
        outcomes.push({
          toolName: call.toolName,
          argsHash: call.argsHash,
          args: call.args,
          outcome: comp.type === 'api_call' ? 'manual_review' : 'manual_review',
          committed: true,
          compensationRegistered: comp.type === 'api_call',
          compensationName: comp.name,
          detail:
            comp.type === 'api_call'
              ? `Committed before the trip. Declared inverse '${comp.name}' is registered in the dashboard but no in-process handler was provided — execute it or reconcile manually.`
              : 'Committed before the trip. This operation is irreversible by design — executed, not reversed. Manual review required.',
          executedAt: new Date(call.timestamp).toISOString(),
        });
      } else if (call.isReadOnly) {
        // Read-only calls executed but mutated nothing external — nothing to reverse.
        outcomes.push({
          toolName: call.toolName,
          argsHash: call.argsHash,
          args: call.args,
          outcome: 'reversed',
          committed: true,
          compensationRegistered: false,
          detail: 'Read-only call — no external state mutated, nothing to reverse.',
          executedAt: new Date(call.timestamp).toISOString(),
        });
      } else {
        // No inverse registered → don't pretend. List it explicitly.
        outcomes.push({
          toolName: call.toolName,
          argsHash: call.argsHash,
          args: call.args,
          outcome: 'manual_review',
          committed: true,
          compensationRegistered: false,
          detail: 'Executed before the trip and committed externally — no compensating action registered. Executed, NOT reversed.',
          executedAt: new Date(call.timestamp).toISOString(),
        });
      }
    }

    const fullyReversed = outcomes.filter(o => o.outcome === 'reversed').length;
    const neverExecuted = outcomes.filter(o => o.outcome === 'never_executed').length;
    const needsManualReview = outcomes.filter(o => o.outcome === 'manual_review');

    // ── 4. Pointer restoration of in-process orchestration state ──────────
    // Offending tool = the newest call that hadn't committed when the loop was
    // intercepted (the loop head about to re-fire), else the last committed
    // call, else the checkpoint's own tool.
    const uncommittedLast = [...uncommittedCalls].reverse()[0];
    const committedLast = [...committedCalls].reverse()[0];
    const offendingLog = uncommittedLast || committedLast;
    const offendingTool =
      options.offendingTool ||
      offendingLog?.toolName ||
      target.lastToolCalled ||
      undefined;
    const truncated = state.restoreFromCheckpoint(target);
    // Truncate the checkpoint ledger to the target too — otherwise stale
    // checkpoints past the rewind point corrupt subsequent rewinds (a default
    // second rewind would target a "future" step) and duplicate keys collide.
    state.checkpointManager.rewindToStep(target.stepIndex);
    // Cancel any pre-checkpoint calls that were never resolved (stale in-flight)
    for (const c of state.toolCalls) {
      if (c.status === 'queued' || c.status === 'in_flight') c.status = 'cancelled';
    }

    // ── 5. HALT + cooldown. Never auto-resume into the same loop. ─────────
    const cooldownSeconds = options.cooldownSeconds ?? state.options.rewindCooldownSeconds ?? 300;
    const cooldownArgsHash =
      options.cooldownScope === 'tool_args' && offendingLog
        ? offendingLog.argsHash
        : undefined;
    const cooldownUntil = state.applyCooldown(offendingTool, cooldownSeconds, cooldownArgsHash);

    state.halted = true;
    state.haltReason =
      needsManualReview.length > 0
        ? `Rewound to ${target.checkpointKey || `ckpt_turn_${target.stepIndex}`}; halted for operator review — ${needsManualReview.length} committed call(s) could not be auto-reversed.`
        : `Rewound to ${target.checkpointKey || `ckpt_turn_${target.stepIndex}`}; halted pending human decision or re-plan.`;

    const receipt: RewindReceipt = {
      receiptId: `rcpt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      runId: state.runId,
      traceId: state.runId,
      agentName: state.agentName,
      checkpoint: {
        key: target.checkpointKey || `ckpt_turn_${target.stepIndex}`,
        stepIndex: target.stepIndex,
        turnNumber: target.turnNumber,
      },
      restored: {
        context: true,
        scratchpad: true,
        retryCounts: true,
        conversationPointer: true,
        truncatedCalls: truncated,
      },
      cancelledQueued: cancelled.length,
      cancelledCalls: cancelled,
      fullyReversed,
      neverExecuted,
      needsManualReview,
      outcomes,
      idempotencyGuaranteed: true,
      halted: true,
      haltReason: state.haltReason,
      offendingTool,
      cooldownUntil,
      cooldownSeconds,
      decision: 'awaiting_decision',
      durationMs: Date.now() - start,
    };

    // ── 6. Persist the receipt (api.moven.dev → rewind_receipts table) ────
    if (options.report !== false && reporter) {
      reporter.reportRewindReceipt(receipt, state).catch(() => {});
    }

    recordRewindSpan({
      runId: state.runId,
      agentId: state.agentId,
      agentName: state.agentName,
      toolName: offendingTool,
      reason: state.haltReason,
      durationMs: receipt.durationMs,
      startedAt: start,
      error: needsManualReview.length > 0,
      attributes: {
        'moven.receipt_id': receipt.receiptId,
        'moven.reversed': receipt.fullyReversed,
        'moven.cancelled': receipt.cancelledQueued,
        'moven.manual_review': needsManualReview.length,
        'moven.cooldown_seconds': cooldownSeconds,
      },
    });
    void MovenOtelExporter.flush();

    return receipt;
  }

  /**
   * Operator decision on a halted run: resume (cooldown cleared or kept),
   * force a re-plan step, or discard the run. Called by dashboard / onPause.
   */
  public static resolve(
    state: MovenRunState,
    decision: 'resume' | 'replan' | 'discard',
    opts: { clearCooldown?: boolean; by?: string } = {}
  ): { ok: boolean; cooldownRemainingMs: number } {
    if (decision === 'discard') {
      state.halted = true;
      state.haltReason = 'Run discarded by operator.';
      return { ok: true, cooldownRemainingMs: state.cooldownRemainingMs() };
    }
    if (decision === 'replan') {
      state.halted = false;
      state.haltReason = undefined;
      state.replanRequested = true;
      // Keep the offending tool on cooldown even across a re-plan — that is
      // the entire point: the re-plan must find another path.
      return { ok: true, cooldownRemainingMs: state.cooldownRemainingMs() };
    }
    // resume
    if (opts.clearCooldown) state.clearCooldowns();
    const remaining = state.cooldownRemainingMs();
    if (remaining > 0) {
      state.halted = false;
      state.haltReason = undefined;
      return { ok: true, cooldownRemainingMs: remaining };
    }
    state.halted = false;
    state.haltReason = undefined;
    return { ok: true, cooldownRemainingMs: 0 };
  }
}
