/**
 * Crash-proof JSON serialization for hot-path hashing and telemetry.
 * Circular refs, BigInt, and functions never throw — they are represented
 * deterministically so hashes stay stable across retries (loop detection and
 * idempotency keys keep working for exotic args).
 */

export function safeStringify(value: unknown, space?: number): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return `${v.toString()}n`;
      if (typeof v === 'function') return `[Function${v.name ? `: ${v.name}` : ''}]`;
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    }, space) ?? 'null';
  } catch {
    return 'null';
  }
}

/**
 * Deterministic string form of a value for hashing. Unlike a
 * timestamp-fallback, the same logical args always produce the same input —
 * which is what makes repeat detection and idempotency keys correct for
 * circular/BigInt args.
 */
export function stableHashInput(value: unknown): string {
  const serialized = safeStringify(value);
  if (serialized !== 'null' || value === null) return serialized;
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;
  // Object whose serialization collapsed (exotic prototype etc.) — fall back to
  // a stable structural description instead of a unique-per-call value.
  try {
    const keys = Object.keys(value as object).sort().join(',');
    const kind = Array.isArray(value) ? 'array' : (value instanceof Map ? 'map' : value instanceof Set ? 'set' : 'object');
    return `complex:${kind}:${keys}`;
  } catch {
    return 'complex:opaque';
  }
}
