/**
 * Production-safe leveled logging for the Moven circuit breaker.
 *
 * Enterprise requirements addressed:
 *  - Log LEVEL control (default `warn` under NODE_ENV=production, `info` in dev)
 *    so ANSI trip banners never spam serverless/JSON log pipelines in prod.
 *  - Pluggable transport: `MovenLogger.setTransport(fn)` routes every line into
 *    Datadog / pino / Winston etc. instead of stdout.
 *  - Structured JSON mode (`MOVEN_LOG_FORMAT=json`) for log aggregators.
 *  - Never throws: a broken transport is isolated from the hot path.
 *
 * Env overrides:
 *  - MOVEN_LOG_LEVEL: silent | error | warn | info | debug
 *  - MOVEN_LOG_FORMAT: text | json
 */

export type MovenLogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface MovenLogFields {
  [key: string]: unknown;
}

export type MovenLogTransport = (level: MovenLogLevel, message: string, fields?: MovenLogFields) => void;

const LEVEL_SEVERITY: Record<MovenLogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function resolveDefaultLevel(): MovenLogLevel {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  const raw = (env?.MOVEN_LOG_LEVEL || '').toLowerCase().trim();
  if (raw && raw in LEVEL_SEVERITY) return raw as MovenLogLevel;
  if (env?.NODE_ENV === 'production' || env?.NODE_ENV === 'test') return 'warn';
  return 'info';
}

function resolveJsonMode(): boolean {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  return (env?.MOVEN_LOG_FORMAT || '').toLowerCase().trim() === 'json';
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return `${v.toString()}n`;
      if (typeof v === 'function') return `[Function${v.name ? `: ${v.name}` : ''}]`;
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    }) ?? 'null';
  } catch {
    return 'null';
  }
}

export class MovenLogger {
  private static level: MovenLogLevel = resolveDefaultLevel();
  private static jsonMode: boolean = resolveJsonMode();
  private static transport?: MovenLogTransport;
  private static lastWarnSignature = '';
  private static lastWarnAt = 0;

  public static getLevel(): MovenLogLevel {
    return this.level;
  }

  public static setLevel(level: MovenLogLevel): void {
    if (level in LEVEL_SEVERITY) this.level = level;
  }

  public static setJsonMode(enabled: boolean): void {
    this.jsonMode = enabled;
  }

  /** Route all Moven logs into an external pipeline (pino, winston, Datadog…). */
  public static setTransport(transport: MovenLogTransport | undefined): void {
    this.transport = transport;
  }

  private static enabled(level: MovenLogLevel): boolean {
    return LEVEL_SEVERITY[level] <= LEVEL_SEVERITY[this.level];
  }

  /** True when `level` would currently be emitted (for rich console features). */
  public static isEnabled(level: MovenLogLevel): boolean {
    return this.enabled(level);
  }

  /** Emits at most one identical warn message per 5s window — no log storms. */
  public static warnOnce(signature: string, message: string, fields?: MovenLogFields): void {
    const now = Date.now();
    if (signature === this.lastWarnSignature && now - this.lastWarnAt < 5000) return;
    this.lastWarnSignature = signature;
    this.lastWarnAt = now;
    this.warn(message, fields);
  }

  public static error(message: string, fields?: MovenLogFields): void {
    this.emit('error', message, fields);
  }

  public static warn(message: string, fields?: MovenLogFields): void {
    this.emit('warn', message, fields);
  }

  public static info(message: string, fields?: MovenLogFields): void {
    this.emit('info', message, fields);
  }

  public static debug(message: string, fields?: MovenLogFields): void {
    this.emit('debug', message, fields);
  }

  private static emit(level: MovenLogLevel, message: string, fields?: MovenLogFields): void {
    if (!this.enabled(level)) return;
    try {
      if (this.transport) {
        this.transport(level, message, fields);
        return;
      }
      if (typeof console === 'undefined') return;
      if (this.jsonMode) {
        const line = safeStringify({ ts: new Date().toISOString(), level, source: 'moven-sdk', message, ...(fields || {}) });
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.log(line);
        return;
      }
      const suffix = fields && Object.keys(fields).length > 0 ? ` ${safeStringify(fields)}` : '';
      if (level === 'error') console.error(`[Moven AI] ${message}${suffix}`);
      else if (level === 'warn') console.warn(`[Moven AI] ${message}${suffix}`);
      else console.log(`[Moven AI] ${message}${suffix}`);
    } catch {
      // Logging must never break the hot path.
    }
  }
}
