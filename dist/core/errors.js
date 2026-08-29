"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MovenPauseError = exports.MovenKillError = void 0;
class MovenKillError extends Error {
    runId;
    heuristic;
    reason;
    toolName;
    toolArgs;
    metrics;
    constructor(params) {
        super(`[Moven AI Circuit Breaker Tripped] ${params.reason}`);
        this.name = 'MovenKillError';
        this.runId = params.runId;
        this.heuristic = params.heuristic;
        this.reason = params.reason;
        this.toolName = params.toolName;
        this.toolArgs = params.toolArgs;
        this.metrics = params.metrics;
        // Ensure proper prototype chain inheritance for custom errors in TS
        Object.setPrototypeOf(this, MovenKillError.prototype);
    }
}
exports.MovenKillError = MovenKillError;
/**
 * Thrown when `pauseOnTrip` is enabled and the circuit breaker wants to
 * PAUSE the agent for human review instead of killing it. Carries the
 * resumeToken so the operator/UI can resolve the halt via
 * MovenRewindEngine.resolve(state, 'resume' | 'replan' | 'discard').
 *
 * The run state is marked halted before this is thrown — the interception
 * guard blocks every subsequent tool call until an operator resumes.
 */
class MovenPauseError extends Error {
    runId;
    reason;
    heuristic;
    toolName;
    toolArgs;
    resumeToken;
    metrics;
    constructor(params) {
        super(`[Moven AI Pause & Ask] ${params.reason}`);
        this.name = 'MovenPauseError';
        this.runId = params.runId;
        this.reason = params.reason;
        this.heuristic = params.heuristic;
        this.toolName = params.toolName;
        this.toolArgs = params.toolArgs;
        this.resumeToken = params.resumeToken;
        this.metrics = params.metrics;
        Object.setPrototypeOf(this, MovenPauseError.prototype);
    }
}
exports.MovenPauseError = MovenPauseError;
