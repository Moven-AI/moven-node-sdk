import { MovenRunState, MovenGuardWarning } from '../core/run-state';
import { MovenReporter } from '../reporter';
import { MovenLogger } from '../core/logger';

/**
 * Framework-agnostic pre-trip warning injection — shared by the LangGraph
 * guard (`createMovenLangGraphGuard().wrapModel`) and the universal breaker
 * (`createMovenCircuitBreaker().warnModel`). Kept in its own module so
 * adapters can share it without import cycles.
 */

const WARNING_HEADER = '[MOVEN CIRCUIT BREAKER WARNING]';

/** Builds the plain-text system notice for a batch of warnings. */
export function buildWarningText(warnings: MovenGuardWarning[]): string {
  const parts = warnings.map((w, i) => `⚠️ Warning ${i + 1}/${warnings.length} (heuristic: ${w.heuristic}${w.toolName ? `, tool: '${w.toolName}'` : ''}): ${w.message}`);
  return `${WARNING_HEADER} The Moven runtime safety layer detected a repeated-tool pattern in this session:\n\n${parts.join('\n\n')}\n\nThis is your ONLY warning before the circuit breaker halts execution.`;
}

/**
 * Returns a NEW messages array with the run's drained warnings appended as a
 * final system-style message. Pure — the input array is never mutated.
 * Framework-agnostic: `{ role, content }` is accepted by LangChain message
 * coercion and is natively the Vercel AI SDK ModelMessage shape — the same
 * shape OpenAI / Anthropic / CrewAI / AutoGen / LlamaIndex accept.
 */
export function withMovenWarnings(state: MovenRunState, messages: any[]): any[] {
  if (!Array.isArray(messages)) return messages;
  const warnings = state.drainWarnings();
  if (warnings.length === 0) return messages;

  MovenLogger.warn('Injecting pre-trip warning into model invocation', {
    runId: state.runId,
    warnings: warnings.map((w) => w.heuristic),
  });

  // Fire-and-forget telemetry + user callback
  const reporter = (state as any).__movenReporter as MovenReporter | undefined;
  if (reporter) {
    reporter.sendPayload({
      event: 'model_warning',
      runId: state.runId,
      agentId: state.agentId,
      agentName: state.agentName,
      warnings: warnings.map((w) => ({ heuristic: w.heuristic, toolName: w.toolName, remaining: w.remaining })),
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  }
  const onWarning = (state.options as any).onModelWarning;
  if (typeof onWarning === 'function') {
    try {
      onWarning({ warnings, runId: state.runId, agentName: state.agentName });
    } catch {}
  }

  return [...messages, { role: 'system', content: buildWarningText(warnings) }];
}
