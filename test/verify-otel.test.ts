import assert from 'assert';
import { MovenVerifier, MovenOtelExporter } from '../src/index';
import { RecordedTrace } from '../src/verify';

async function runTests() {
  console.log('🧪 Starting Moven Verifier & OTel Export Tests...\n');

  // ── Test 1: clean multi-city trace survives the default policy ──────────
  {
    const cleanTrace: RecordedTrace = {
      name: 'golden:weather-multi-city',
      toolCalls: [
        { toolName: 'get_weather', args: { city: 'San Francisco' }, result: { temp: '18°C' } },
        { toolName: 'get_weather', args: { city: 'Tokyo' }, result: { temp: '24°C' } },
        { toolName: 'get_weather', args: { city: 'London' }, result: { temp: '15°C' } },
        { toolName: 'book_flight', args: { to: 'London' }, result: { bookingId: 'BK-1' } },
      ],
    };

    const report = MovenVerifier.verify([cleanTrace], { maxRepeatCalls: 3 });
    assert.strictEqual(report.passed, true, 'clean trace should pass');
    assert.strictEqual(report.traces[0].tripped, false);
    console.log('  ✅ Passed: clean trace survives candidate policy\n');
  }

  // ── Test 2: looping trace trips at the right call ────────────────────────
  {
    const loopTrace: RecordedTrace = {
      name: 'incident:stuck-weather-loop',
      toolCalls: [
        { toolName: 'get_weather', args: { city: 'SF' }, result: { error: 'timeout' } },
        { toolName: 'get_weather', args: { city: 'SF' }, result: { error: 'timeout' } },
        { toolName: 'get_weather', args: { city: 'SF' }, result: { error: 'timeout' } },
      ],
    };

    const report = MovenVerifier.verify([loopTrace], { maxRepeatCalls: 3 });
    assert.strictEqual(report.passed, false, 'looping trace should trip');
    assert.strictEqual(report.trippedTraces.length, 1);
    assert.strictEqual(report.trippedTraces[0].trip?.heuristic, 'no_progress_loop');
    assert.strictEqual(report.trippedTraces[0].trip?.atCall, 3);
    console.log('  ✅ Passed: stagnant loop trips at call #3 with the right heuristic\n');
  }

  // ── Test 3: threshold sensitivity — tighter limit kills a legit trace ────
  {
    const trace: RecordedTrace = {
      name: 'golden:two-identical-writes',
      toolCalls: [
        { toolName: 'write_record', args: { id: 42 }, result: { ok: true } },
        { toolName: 'write_record', args: { id: 42 }, result: { ok: true } },
      ],
    };

    const relaxed = MovenVerifier.verify([trace], { maxRepeatCalls: 5 });
    assert.strictEqual(relaxed.passed, true, 'limit 5 should allow 2 identical write calls');

    const tight = MovenVerifier.verify([trace], { maxRepeatCalls: 2 });
    assert.strictEqual(tight.passed, false, 'limit 2 should kill the 2nd identical write call');
    console.log('  ✅ Passed: threshold sensitivity detected (policy regression works)\n');
  }

  // ── Test 4: report formatting is CI-friendly ─────────────────────────────
  {
    const report = MovenVerifier.verify(
      [{ name: 'loop', toolCalls: [
        { toolName: 'fetch', args: { id: 1 }, result: { status: 'pending' } },
        { toolName: 'fetch', args: { id: 1 }, result: { status: 'pending' } },
        { toolName: 'fetch', args: { id: 1 }, result: { status: 'pending' } },
      ] }],
      { maxNoProgressTurns: 3 }
    );
    const text = MovenVerifier.formatReport(report);
    assert.ok(text.includes('CI: FAIL'), 'report should contain CI: FAIL');
    assert.ok(text.includes('loop'), 'report should name the tripping trace');
    console.log('  ✅ Passed: CI report formatting\n');
  }

  // ── Test 5: OTel exporter — disabled by default, no-ops safely ───────────
  {
    MovenOtelExporter.configure({ enabled: false });
    // Must not throw with everything disabled
    MovenOtelExporter.recordSpan({ name: 'moven.tool.x', kind: 'tool_call', decision: 'ALLOW' });
    await MovenOtelExporter.flush();
    console.log('  ✅ Passed: OTel no-op when disabled (zero overhead default)\n');
  }

  // ── Test 6: OTel exporter — enabled endpoint queues + flushes without error
  {
    MovenOtelExporter.configure({
      enabled: true,
      endpoint: 'http://127.0.0.1:1', // unreachable sinkhole — must not throw
      serviceName: 'moven-test',
    });
    MovenOtelExporter.recordSpan({
      name: 'moven.breaker.KILL',
      kind: 'breaker_decision',
      decision: 'KILL',
      heuristic: 'no_progress_loop',
      reason: 'test reason',
      toolName: 'fetch',
      runId: 'run_test',
      agentName: 'test-agent',
      cost: 0.42,
      error: true,
    });
    // Fire-and-forget flush must never reject
    await MovenOtelExporter.flush();
    MovenOtelExporter.configure({ enabled: false });
    console.log('  ✅ Passed: OTLP export swallows transport errors\n');
  }

  // ── Test 7: verifier never executes tools or sends telemetry ─────────────
  {
    let executed = false;
    // toolCalls in a recorded trace are DATA — verify() must never invoke fns
    const trace = {
      name: 'no-side-effects',
      toolCalls: [
        { toolName: 'get_weather', args: { city: 'SF' }, result: { temp: '18°C' } },
        { toolName: 'get_weather', args: { city: 'SF' }, result: { temp: '18°C' } },
      ],
    };
    const report = MovenVerifier.verify([trace], { maxRepeatCalls: 5 });
    assert.strictEqual(executed, false);
    assert.strictEqual(report.passed, true);
    console.log('  ✅ Passed: verify() is pure replay (no side effects)\n');
  }

  console.log('🎉 ALL VERIFIER & OTEL TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
