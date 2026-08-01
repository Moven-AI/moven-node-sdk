"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MovenKillError = void 0;
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
