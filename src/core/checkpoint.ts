export interface AgentCheckpointState {
  stepIndex: number;
  traceId: string;
  agentId: string;
  stepName?: string;
  model?: string;
  systemPrompt?: string;
  userPrompt?: string;
  prompt?: string;
  lastToolCalled?: string;
  lastToolArgs?: any;
  messagesSnapshot?: any[];
  memorySnapshot?: Record<string, any>;
  stateSnapshot?: Record<string, any>;
  cumulativeCost: number;
  parentCheckpointId?: string;
  isForked?: boolean;
  forkLabel?: string;
  timestamp: number;
}

export class MovenCheckpointManager {
  private checkpoints: AgentCheckpointState[] = [];

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
    stepName?: string
  ): AgentCheckpointState {
    const parentId = this.checkpoints.length > 0 
      ? `ckpt_${traceId}_step_${this.checkpoints[this.checkpoints.length - 1].stepIndex}`
      : undefined;

    const checkpoint: AgentCheckpointState = {
      stepIndex,
      traceId,
      agentId,
      stepName: stepName || lastToolCalled || `step_${stepIndex}`,
      model: model || 'gpt-4o',
      systemPrompt,
      userPrompt,
      prompt: userPrompt,
      lastToolCalled,
      lastToolArgs,
      messagesSnapshot,
      memorySnapshot,
      stateSnapshot: memorySnapshot || (messagesSnapshot ? { messages: messagesSnapshot } : { args: lastToolArgs }),
      cumulativeCost,
      parentCheckpointId: parentId,
      timestamp: Date.now(),
    };

    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  public getCheckpoints(): AgentCheckpointState[] {
    return [...this.checkpoints];
  }

  public rewindToStep(stepIndex: number): AgentCheckpointState | null {
    const idx = this.checkpoints.findIndex(c => c.stepIndex === stepIndex);
    if (idx === -1) return null;

    // Truncate future checkpoints to rewind to step N
    const target = this.checkpoints[idx];
    this.checkpoints = this.checkpoints.slice(0, idx + 1);
    return target;
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
