/**
 * Moven OTel Export — zero-dependency OpenTelemetry integration.
 *
 * Emits one span per circuit-breaker decision and per guarded tool call so
 * breaker activity lands in the user's EXISTING observability stack
 * (Datadog, Grafana Tempo, Honeycomb, Jaeger…) without touching the
 * Moven dashboard.
 *
 * Two export paths, both optional and off by default:
 *   1. OTel API bridge  — if `@opentelemetry/api` is installed in the host
 *      app, spans are created through its global tracer (they join the
 *      host's active context and are exported by the host's SDK).
 *   2. OTLP/HTTP JSON   — if `OTEL_EXPORTER_OTLP_ENDPOINT` (or
 *      options.otel.endpoint) is set, spans are exported directly in the
 *      OTLP/HTTP JSON encoding (POST /v1/traces), no SDK needed.
 *
 * Zero overhead when disabled: every call site no-ops to a boolean check.
 */

import type { MovenHeuristicType } from './core/errors';

export interface MovenOtelOptions {
  /** Master switch. Default: auto (enabled when an endpoint or OTel API is detected). */
  enabled?: boolean;
  /** OTLP/HTTP endpoint. Default: OTEL_EXPORTER_OTLP_ENDPOINT env. */
  endpoint?: string;
  /** Tracer/service name. Default: 'moven-sdk'. */
  serviceName?: string;
  /** Attribute-only sample rate 0..1 for tool-call spans (decisions are always recorded). Default: 1. */
  toolCallSampleRate?: number;
  /** Extra resource attributes merged into OTLP payloads. */
  resourceAttributes?: Record<string, string>;
}

export interface MovenSpanInput {
  /** Span name. Defaults are applied per kind when omitted. */
  name?: string;
  /** 'tool_call' | 'breaker_decision' | 'rewind'. Default: 'tool_call'. */
  kind?: 'tool_call' | 'breaker_decision' | 'rewind';
  runId?: string;
  agentId?: string;
  agentName?: string;
  toolName?: string;
  decision?: 'ALLOW' | 'WARN' | 'BLOCK' | 'REPLAN' | 'PAUSE' | 'FALLBACK' | 'KILL' | 'DRY_RUN' | 'CANCELLED';
  heuristic?: MovenHeuristicType | string;
  reason?: string;
  cost?: number;
  latencyMs?: number;
  similarity?: number;
  error?: boolean;
  attributes?: Record<string, string | number | boolean>;
  /** Pre-computed duration for finished spans (ms). */
  durationMs?: number;
  startedAt?: number;
}

type OtelApi = {
  trace: {
    getTracer: (name: string, version?: string) => {
      startSpan: (name: string, opts?: any) => any;
    };
  };
  SpanStatusCode?: { ERROR?: number; OK?: number };
  context?: { active: () => any };
};

/** Span buffer for OTLP batching. */
interface QueuedSpan {
  input: MovenSpanInput;
  startedAt: number;
  endedAt: number;
  traceId: string;
  spanId: string;
}

export class MovenOtelExporter {
  private static options: MovenOtelOptions = {};
  private static otelApi: OtelApi | null | undefined; // undefined = not probed yet
  private static queue: QueuedSpan[] = [];
  private static flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly BATCH_LIMIT = 64;
  private static readonly FLUSH_INTERVAL_MS = 2000;

  /** Configure once per process (e.g. from moven.init or the first wrap call). */
  public static configure(options?: MovenOtelOptions): void {
    const envEndpoint =
      typeof process !== 'undefined' ? process.env?.OTEL_EXPORTER_OTLP_ENDPOINT : undefined;

    const endpoint = options?.endpoint || envEndpoint || '';
    const explicitEnabled = options?.enabled;
    this.options = {
      endpoint: endpoint.replace(/\/$/, ''),
      serviceName: options?.serviceName || 'moven-sdk',
      toolCallSampleRate: options?.toolCallSampleRate ?? 1,
      resourceAttributes: options?.resourceAttributes,
      // Default: enabled when an endpoint is present OR explicitly requested
      enabled: explicitEnabled ?? (Boolean(endpoint) || explicitEnabled === true),
      ...options,
    };
    // Probe the OTel API bridge lazily on first span, not at configure time.
    this.otelApi = undefined;
  }

  public static isEnabled(): boolean {
    const opts = this.options;
    if (opts.enabled === false) return false;
    if (opts.enabled === true) return true;
    return Boolean(opts.endpoint) || this.probeOtelApi() !== null;
  }

  private static probeOtelApi(): OtelApi | null {
    if (this.otelApi !== undefined) return this.otelApi;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const req = typeof require === 'function' ? require : null;
      if (req) {
        const api = req('@opentelemetry/api');
        if (api?.trace?.getTracer) {
          this.otelApi = api as OtelApi;
          return this.otelApi;
        }
      }
    } catch {
      /* @opentelemetry/api not installed — fine */
    }
    this.otelApi = null;
    return null;
  }

  private static randomHex(bytes: number): string {
    const arr = new Uint8Array(bytes);
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Record a finished span. Never throws; costs O(attributes).
   */
  public static recordSpan(input: MovenSpanInput): void {
    if (!this.isEnabled()) return;
    try {
      const now = Date.now();
      const startedAt = input.startedAt ?? (input.durationMs !== undefined ? now - input.durationMs : now);
      const endedAt = input.durationMs !== undefined ? startedAt + input.durationMs : now;

      const api = this.probeOtelApi();
      if (api) {
        const tracer = api.trace.getTracer(this.options.serviceName || 'moven-sdk');
        const spanName = input.name
          || (input.kind === 'rewind' ? 'moven.rewind'
            : input.kind === 'breaker_decision'
              ? `moven.breaker.${input.decision || input.heuristic || 'decision'}`
              : `moven.tool.${input.toolName || 'unknown'}`);
        const span = tracer.startSpan(spanName, {
          startTime: startedAt,
          attributes: this.buildAttributes(input),
        });
        if (input.error && api.SpanStatusCode?.ERROR !== undefined) {
          span.setStatus({ code: api.SpanStatusCode.ERROR, message: input.reason });
        }
        span.end(endedAt);
        return; // host SDK owns export
      }

      if (!this.options.endpoint) return;

      this.queue.push({
        input,
        startedAt,
        endedAt,
        traceId: this.randomHex(16),
        spanId: this.randomHex(8),
      });

      if (this.queue.length >= this.BATCH_LIMIT) {
        void this.flush();
      } else if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush();
        }, this.FLUSH_INTERVAL_MS);
        // Don't hold the process open for telemetry
        if (typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
          (this.flushTimer as any).unref?.();
        }
      }
    } catch {
      /* telemetry must never break the guarded run */
    }
  }

  private static buildAttributes(input: MovenSpanInput): Record<string, string | number | boolean> {
    return {
      'moven.kind': input.kind ?? 'span',
      'moven.run_id': input.runId ?? '',
      'moven.agent_id': input.agentId ?? '',
      'moven.agent_name': input.agentName ?? '',
      'moven.tool': input.toolName ?? '',
      'moven.decision': input.decision ?? '',
      'moven.heuristic': input.heuristic ?? '',
      'moven.reason': (input.reason ?? '').substring(0, 512),
      'moven.cost_usd': input.cost ?? 0,
      'moven.latency_ms': input.latencyMs ?? 0,
      'moven.similarity': input.similarity ?? 0,
      'moven.error': input.error === true,
      ...(this.options.resourceAttributes || {}),
      ...(input.attributes || {}),
    };
  }

  /** Ship queued spans via OTLP/HTTP JSON. Fire-and-forget. */
  public static async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const endpoint = this.options.endpoint;
    if (!endpoint) return;

    const now = Date.now() * 1e6; // ns
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: this.options.serviceName || 'moven-sdk' } },
              ...Object.entries(this.options.resourceAttributes || {}).map(([k, v]) => ({
                key: k,
                value: { stringValue: String(v) },
              })),
            ],
          },
          scopeSpans: [
            {
              scope: { name: 'moven-sdk', version: '0.3.0' },
              spans: batch.map(q => ({
                traceId: q.traceId,
                spanId: q.spanId,
                name: q.input.name,
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: String(q.startedAt * 1e6),
                endTimeUnixNano: String(q.endedAt * 1e6),
                attributes: Object.entries(this.buildAttributes(q.input)).map(([key, v]) => ({
                  key,
                  value:
                    typeof v === 'number'
                      ? { doubleValue: v }
                      : typeof v === 'boolean'
                        ? { boolValue: v }
                        : { stringValue: String(v) },
                })),
                status: q.input.error
                  ? { code: 2, message: (q.input.reason || 'error').substring(0, 256) }
                  : { code: 1 },
              })),
            },
          ],
        },
      ],
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      if (typeof timeout === 'object' && 'unref' in timeout) (timeout as any).unref?.();
      await fetch(`${endpoint}/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      /* swallow — telemetry must never break the run */
    }
    void now;
  }
}

/** Convenience wrappers for the three span kinds. */
export function recordToolCallSpan(input: MovenSpanInput): void {
  MovenOtelExporter.recordSpan({ ...input, name: input.name || `moven.tool.${input.toolName || 'unknown'}`, kind: 'tool_call' });
}

export function recordDecisionSpan(input: MovenSpanInput): void {
  MovenOtelExporter.recordSpan({
    ...input,
    name: input.name || `moven.breaker.${input.decision || input.heuristic || 'decision'}`,
    kind: 'breaker_decision',
  });
}

export function recordRewindSpan(input: MovenSpanInput): void {
  MovenOtelExporter.recordSpan({ ...input, name: input.name || 'moven.rewind', kind: 'rewind' });
}
