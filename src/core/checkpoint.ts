// ─────────────────────────────────────────────────────────────────────────────
// Moven Checkpoint Manager — Mechanism 1: in-process state snapshotting.
//
// Checkpoints are immutable pointer-restorable snapshots of everything that
// lives inside the process: conversation history, agent context/plan,
// scratchpad, retry counters. State is deep-copied at capture time (agent
// state per turn is a few KB of JSON, so this is near-free) and stored
// keyed by turn with a bounded retention window. A rewind is literally
// `state = checkpoints[key]` — no magic, no external side effects implied.
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentCheckpointState {
  stepIndex: number;
  traceId: string;
  agentId: string;
  /** Stable key, e.g. 'ckpt_turn_2' — used by the dashboard rewind UI */
  checkpointKey?: string;
  /** Human turn number (#8841 style) */
  turnNumber?: number;
  stepName?: string;
  model?: string;
  systemPrompt?: string;
  userPrompt?: string;
  prompt?: string;
  lastToolCalled?: string;
  lastToolArgs?: any;
  /** Immutable snapshot of conversation history (bounded) */
  messagesSnapshot?: any[];
  memorySnapshot?: Record<string, any>;
  stateSnapshot?: Record<string, any>;
  /** Agent context / plan — restored on rewind (in-process only) */
  context?: Record<string, any>;
  /** Working scratchpad — restored on rewind (in-process only) */
  scratchpad?: Record<string, any>;
  /** Per-tool retry counters — restored on rewind (in-process only) */
  retryCounts?: Record<string, number>;
  cumulativeCost: number;
  parentCheckpointId?: string;
  isForked?: boolean;
  forkLabel?: string;
  timestamp: number;
}

export type CompensationFn = (args: any, result: any) => any | Promise<any>;

export interface CompensationEntry {
  toolName: string;
  /** 'handler' = in-process inverse function (saga). 'api_call' = declarative inverse stored in DB. 'manual' = no safe inverse exists. */
  type: 'handler' | 'api_call' | 'manual';
  /** Name of the inverse operation, e.g. 'db.delete_row', 'stripe.reverse_transfer' */
  name?: string;
  /** Declarative inverse config (persisted to tool_compensations in the DB) */
  config?: Record<string, any>;
  /** In-process inverse function (never serialized — DB stores type/name/config only) */
  fn?: CompensationFn;
  description?: string;
  /** Timeout for running the compensating handler during rewind (default 5000ms) */
  timeoutMs?: number;
}

export type CompensationInput = CompensationFn | (Omit<CompensationEntry, 'toolName' | 'fn'> & { fn?: CompensationFn });

/**
 * Registry of compensating actions (saga pattern).
 * Register an inverse alongside the protected tool; rewind executes the
 * inverse for each call that committed since the checkpoint.
 *   moven.registerCompensation('create_row', (args, result) => db.delete_row(result.id))
 */
export class MovenCompensationRegistry {
  private entries = new Map<string, CompensationEntry>();

  public register(toolName: string, input: CompensationInput): CompensationEntry {
    const entry: CompensationEntry =
      typeof input === 'function'
        ? { toolName, type: 'handler', name: `${toolName}__compensate`, fn: input as CompensationFn }
        : {
            toolName,
            type: input.type || (input.fn ? 'handler' : 'manual'),
            name: input.name || (input.fn ? `${toolName}__compensate` : `manual_review_${toolName}`),
            config: input.config,
            fn: input.fn,
            description: input.description,
            timeoutMs: input.timeoutMs,
          };
    this.entries.set(toolName, entry);
    return entry;
  }

  public get(toolName: string): CompensationEntry | undefined {
    return this.entries.get(toolName);
  }

  public has(toolName: string): boolean {
    return this.entries.has(toolName);
  }

  public unregister(toolName: string): boolean {
    return this.entries.delete(toolName);
  }

  /** Serializable form for DB persistence (tool_compensations table) — functions stripped */
  public list(): Omit<CompensationEntry, 'fn'>[] {
    return Array.from(this.entries.values()).map(({ fn, ...rest }) => rest);
  }
}

/** Deep-copy helper for small in-process state. Falls back gracefully on exotic values. */
export function snapshotState<T>(value: T, depth: number = 0): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    // Structured clone handles Maps/Sets/Dates; agent state is small so cost is trivial
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
  } catch {
    /* fall through to JSON copy */
  }
  if (depth > 6) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

export class MovenCheckpointManager {
  private checkpoints: AgentCheckpointState[] = [];
  /** Bounded retention window — rewind never needs indefinite history */
  private maxCheckpoints: number;

  constructor(maxCheckpoints: number = 50) {
    this.maxCheckpoints = Math.max(1, maxCheckpoints);
  }

  public createCheckpoint(
    traceId: string,
    agentId: string,
    stepIndex: number,
    lastToolCalled?: string,
    lastToolArgs?: any,
    cumulativeCost: number = 0,
    messagesSnapshot?: any[],
    memorySnapshot?: Record<string, any>,
    systemPrompt?: string,
    userPrompt?: string,
    model?: string,
    stepName?: string,
    orchestration?: {
      context?: Record<string, any>;
      scratchpad?: Record<string, any>;
      retryCounts?: Record<string, number>;
      turnNumber?: number;
    }
  ): AgentCheckpointState {
    const parentId = this.checkpoints.length > 0
      ? `ckpt_${traceId}_step_${this.checkpoints[this.checkpoints.length - 1].stepIndex}`
      : undefined;

    // Immutable snapshots — captured ONCE here so a checkpoint is just a
    // reference to a prior version, never mutated by later turns.
    const context = orchestration?.context ? snapshotState(orchestration.context) : {};
    const scratchpad = orchestration?.scratchpad ? snapshotState(orchestration.scratchpad) : {};
    const retryCounts = orchestration?.retryCounts ? snapshotState(orchestration.retryCounts) : {};
    const boundedMessages = messagesSnapshot && messagesSnapshot.length > 50
      ? snapshotState(messagesSnapshot.slice(-50))
      : (messagesSnapshot ? snapshotState(messagesSnapshot) : undefined);

    const checkpoint: AgentCheckpointState = {
      stepIndex,
      traceId,
      agentId,
      checkpointKey: `ckpt_turn_${stepIndex}`,
      turnNumber: orchestration?.turnNumber ?? stepIndex,
      stepName: stepName || lastToolCalled || `step_${stepIndex}`,
      model: model || 'gpt-4o',
      systemPrompt,
      userPrompt,
      prompt: userPrompt,
      lastToolCalled,
      lastToolArgs: snapshotState(lastToolArgs),
      messagesSnapshot: boundedMessages,
      memorySnapshot: memorySnapshot ? snapshotState(memorySnapshot) : undefined,
      stateSnapshot: memorySnapshot || (messagesSnapshot ? { messages: messagesSnapshot } : { args: lastToolArgs }),
      context,
      scratchpad,
      retryCounts,
      cumulativeCost,
      parentCheckpointId: parentId,
      timestamp: Date.now(),
    };

    this.checkpoints.push(checkpoint);

    // Enforce retention window (drop oldest)
    if (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints = this.checkpoints.slice(this.checkpoints.length - this.maxCheckpoints);
    }

    return checkpoint;
  }

  public getCheckpoints(): AgentCheckpointState[] {
    return [...this.checkpoints];
  }

  public getCheckpointByKey(key: string): AgentCheckpointState | null {
    return this.checkpoints.find(c => c.checkpointKey === key || c.checkpointKey === `ckpt_turn_${key.replace('ckpt_turn_', '')}`) || null;
  }

  public getLatest(): AgentCheckpointState | null {
    return this.checkpoints.length > 0 ? this.checkpoints[this.checkpoints.length - 1] : null;
  }

  /**
   * Pointer restoration: truncate to the target checkpoint and return it.
   * Restoring the caller's live state is the rewind engine's job — this only
   * manages the checkpoint ledger.
   */
  public rewindToStep(stepIndex: number): AgentCheckpointState | null {
    const idx = this.checkpoints.findIndex(c => c.stepIndex === stepIndex);
    if (idx === -1) return null;

    const target = this.checkpoints[idx];
    this.checkpoints = this.checkpoints.slice(0, idx + 1);
    return target;
  }

  /** Drops the entire ledger (used by the kill auto-fallback reset path). */
  public clear(): void {
    this.checkpoints = [];
  }

  public forkFromStep(
    stepIndex: number,
    forkLabel: string,
    updatedArgs?: any
  ): AgentCheckpointState | null {
    const target = this.rewindToStep(stepIndex);
    if (!target) return null;

    const newStepIndex = target.stepIndex + 1;
    const forkedCheckpoint: AgentCheckpointState = {
      ...target,
      stepIndex: newStepIndex,
      parentCheckpointId: `ckpt_${target.traceId}_step_${target.stepIndex}`,
      lastToolArgs: updatedArgs || target.lastToolArgs,
      isForked: true,
      forkLabel,
      timestamp: Date.now(),
    };

    this.checkpoints.push(forkedCheckpoint);
    return forkedCheckpoint;
  }
}
