import { MovenRunState, MovenOptions } from './run-state';
import { MovenReporter } from '../reporter';

export interface CheckpointData {
  stepIndex: number;
  stepName: string;
  stateSnapshot: any;
  model?: string;
  systemPrompt?: string;
}

export class MovenCheckpointEngine {
  private state: MovenRunState;
  private checkpoints: Map<number, CheckpointData> = new Map();
  private reporter?: MovenReporter;

  constructor(state: MovenRunState, reporter?: MovenReporter) {
    this.state = state;
    this.reporter = reporter;
  }

  // 1. CHECKPOINT: Save execution state at current step
  public checkpoint(stepIndex: number, stepName: string, stateSnapshot: any, model?: string, systemPrompt?: string): CheckpointData {
    const cp: CheckpointData = {
      stepIndex,
      stepName,
      stateSnapshot,
      model: model || this.state.activeModel,
      systemPrompt,
    };
    this.checkpoints.set(stepIndex, cp);

    // Stream checkpoint to telemetry server asynchronously
    if (this.reporter) {
      this.reporter.sendPayload({
        event: 'checkpoint',
        runId: this.state.runId,
        agentId: this.state.agentId,
        agentName: this.state.agentName,
        stepIndex,
        stepName,
        stateSnapshot,
        model: cp.model,
        timestamp: Date.now(),
      }).catch(() => {});
    }

    return cp;
  }

  // 2. REWIND (Ctrl+Z): Get snapshot to roll back state to stepIndex
  public rewind(stepIndex: number): CheckpointData | null {
    const cp = this.checkpoints.get(stepIndex);
    if (!cp) return null;

    // Prune tool calls & depth beyond stepIndex
    this.state.depth = stepIndex;
    this.state.cleanTurnsCount = 0;

    if (this.reporter) {
      this.reporter.sendPayload({
        event: 'rewind',
        runId: this.state.runId,
        agentId: this.state.agentId,
        agentName: this.state.agentName,
        stepIndex,
        timestamp: Date.now(),
      }).catch(() => {});
    }

    return cp;
  }

  // 3. FORK: Create a new branch of execution from stepIndex with overrides
  public fork(stepIndex: number, overrides: { model?: string; disableTools?: string[]; systemPrompt?: string }): { newRunId: string; checkpoint: CheckpointData | null } {
    const cp = this.rewind(stepIndex);
    const newRunId = `fork_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    if (overrides.model) {
      this.state.activeModel = overrides.model;
    }

    if (this.reporter) {
      this.reporter.sendPayload({
        event: 'fork',
        runId: this.state.runId,
        newRunId,
        agentId: this.state.agentId,
        agentName: this.state.agentName,
        stepIndex,
        overrides,
        timestamp: Date.now(),
      }).catch(() => {});
    }

    return { newRunId, checkpoint: cp };
  }

  public getCheckpoints(): CheckpointData[] {
    return Array.from(this.checkpoints.values()).sort((a, b) => a.stepIndex - b.stepIndex);
  }
}
