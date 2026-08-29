import { MovenOptions } from './run-state';
import { MovenLogger } from './logger';

/**
 * Enterprise hardening: defensive validation of circuit-breaker thresholds.
 *
 * An invalid user config must NEVER silently disable a safety limit. E.g.
 *  - maxDepth: -1        → would trip the breaker instantly at depth 0
 *  - maxRepeatCalls: 0   → falsy-coalesced to default in some paths but not others
 *  - maxCostDollar: NaN  → NaN comparisons are always false → cost ceiling NEVER trips
 *
 * This validator clamps every numeric threshold into a safe, finite, positive
 * range and emits a one-time warning so operators see the misconfiguration.
 */

interface ClampSpec {
  min: number;
  max: number;
  fallback: number;
}

const NUMERIC_SPECS: { key: keyof MovenOptions; spec: ClampSpec }[] = [
  { key: 'maxRepeatCalls', spec: { min: 1, max: 10_000, fallback: 5 } },
  { key: 'repeatTimeWindowMs', spec: { min: 1_000, max: 3_600_000, fallback: 60_000 } },
  { key: 'maxCostDollar', spec: { min: 0.01, max: 1_000_000, fallback: 2.0 } },
  { key: 'maxDepth', spec: { min: 1, max: 100_000, fallback: 15 } },
  { key: 'maxNoProgressTurns', spec: { min: 2, max: 1_000, fallback: 3 } },
  { key: 'maxErrorRatePct', spec: { min: 1, max: 100, fallback: 50 } },
  { key: 'maxSlowCallLatencyMs', spec: { min: 100, max: 3_600_000, fallback: 30_000 } },
  { key: 'maxSlowCallRatePct', spec: { min: 1, max: 100, fallback: 40 } },
  { key: 'maxSchemaValidationFailures', spec: { min: 1, max: 1_000, fallback: 3 } },
  { key: 'maxTokensPerStep', spec: { min: 1, max: 10_000_000, fallback: 8_192 } },
  { key: 'slidingWindowRequests', spec: { min: 5, max: 10_000, fallback: 20 } },
  { key: 'pollingTtlSeconds', spec: { min: 1, max: 86_400, fallback: 600 } },
  { key: 'maxCheckpoints', spec: { min: 1, max: 10_000, fallback: 50 } },
  { key: 'rewindCooldownSeconds', spec: { min: 0, max: 86_400, fallback: 300 } },
  { key: 'maxToolCallHistory', spec: { min: 10, max: 1_000_000, fallback: 500 } },
  { key: 'maxPromptHistory', spec: { min: 10, max: 100_000, fallback: 200 } },
  { key: 'percentileStepBaseline', spec: { min: 1, max: 100_000, fallback: 15 } },
  { key: 'humanAttestationWindowMs', spec: { min: 0, max: 3_600_000, fallback: 300_000 } },
  { key: 'maxHumanAttestedStagnantSteps', spec: { min: 2, max: 10_000, fallback: 12 } },
  { key: 'intentDirectiveThreshold', spec: { min: 0.05, max: 1, fallback: 0.5 } },
];

function clampNumber(value: unknown, spec: ClampSpec): { value: number; clamped: boolean } {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { value: spec.fallback, clamped: true };
  }
  if (value < spec.min) return { value: spec.min, clamped: true };
  if (value > spec.max) return { value: spec.max, clamped: true };
  return { value, clamped: false };
}

/**
 * Returns a sanitized copy of `options` with all numeric thresholds clamped
 * into safe ranges. Warnings are emitted (rate-limited) for every correction.
 */
export function validateAndClampOptions(options: MovenOptions = {}): MovenOptions {
  const sanitized: MovenOptions = { ...options };
  for (const { key, spec } of NUMERIC_SPECS) {
    const provided = (options as any)[key];
    if (provided === undefined || provided === null) continue;
    const { value, clamped } = clampNumber(provided, spec);
    if (clamped) {
      (sanitized as any)[key] = value;
      MovenLogger.warnOnce(
        `opt:${String(key)}`,
        `Invalid circuit breaker option '${String(key)}'=${String(provided)} — clamped to ${value} (safe range ${spec.min}–${spec.max}).`,
        { option: String(key), provided, clampedTo: value }
      );
    }
  }

  // Cross-field sanity: adaptive baseline must not exceed the depth ceiling cap
  // (heuristics.ts already guards this, but surface the misconfiguration too).
  if (
    typeof sanitized.percentileStepBaseline === 'number' &&
    typeof sanitized.maxDepth === 'number' &&
    sanitized.percentileStepBaseline > sanitized.maxDepth * 10
  ) {
    MovenLogger.warnOnce(
      'opt:percentileStepBaseline',
      `percentileStepBaseline (${sanitized.percentileStepBaseline}) is more than 10x maxDepth (${sanitized.maxDepth}) — adaptive depth scaling may never trigger.`
    );
  }

  return sanitized;
}
