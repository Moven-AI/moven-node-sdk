import assert from 'assert';
import { MovenRunState } from '../src/core/run-state';
import { MovenHeuristicsEngine } from '../src/core/heuristics';
import { MovenKillHandler } from '../src/kill/abort';
import { MovenReporter } from '../src/reporter';
import { MovenLogger, MovenLogLevel } from '../src/core/logger';

/**
 * Enterprise hardening suite.
 * Verifies the production-grade guarantees of the circuit breaker core:
 *  1. Invalid thresholds are clamped (never silently disable a ceiling)
 *  2. Sub-detectors / custom rules fail open on internal crashes
 *  3. Run-state memory is bounded
 *  4. Kill side effects are single-flight under concurrent trips
 *  5. Telemetry export self-protects when the backend is down
 */

async function runHardeningTests() {
  console.log('🧪 Starting Enterprise Hardening Tests...\n');

  // Test 1: Invalid numeric thresholds are clamped into safe ranges
  {
    console.log('Test 1: Option Validation Clamps Invalid Thresholds');
    const state = new MovenRunState({
      maxDepth: -5,                 // would trip instantly at depth 0
      maxCostDollar: NaN,           // NaN comparisons never trip → ceiling disabled
      maxRepeatCalls: 0,            // zero disables repeat detection
      maxTokensPerStep: Infinity,   // unbounded burst ceiling
    } as any);

    assert.strictEqual(state.options.maxDepth, 1, 'maxDepth clamped to minimum 1');
    assert.strictEqual(state.options.maxCostDollar, 2.00, 'NaN maxCostDollar clamped to default 2.00');
    assert.strictEqual(state.options.maxRepeatCalls, 1, 'maxRepeatCalls clamped to minimum 1');
    assert.strictEqual(state.options.maxTokensPerStep, 8192, 'Infinity maxTokensPerStep clamped to default 8192');
    console.log('  ✅ Passed Option Validation Clamping\n');
  }

  // Test 2: A throwing customCheck fails open — the guarded call survives
  {
    console.log('Test 2: Throwing customCheck Is Fail-Safe');
    const state = new MovenRunState({
      customCheck: () => {
        throw new Error('developer rule exploded');
      },
    });

    const result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, false, 'a crashing custom rule must not crash evaluate()');
    console.log('  ✅ Passed customCheck Fail-Safety\n');
  }

  // Test 3: A crashing sub-detector fails open, hard ceilings still trip
  {
    console.log('Test 3: Crashing Sub-Detector Fails Open, Hard Ceilings Remain');
    // Sabotage toolCalls with a poisoned entry that breaks result hashing
    const state = new MovenRunState({ maxDepth: 1 });
    (state as any).toolCalls = [
      { toolName: 't', args: {}, argsHash: 'x', timestamp: Date.now(), status: 'in_flight' },
    ];
    (state as any).layer2Guard = {
      evaluate: () => {
        throw new Error('layer2 engine bug');
      },
    };
    state.depth = 2; // beyond the maxDepth ceiling of 1

    const result = MovenHeuristicsEngine.evaluate(state);
    // layer2 crashed (fail-open) but the depth ceiling is deterministic and still trips
    assert.strictEqual(result.tripped, true, 'hard depth ceiling must still trip');
    assert.strictEqual(result.heuristic, 'depth_ceiling');
    console.log('  ✅ Passed Sub-Detector Fail-Open + Hard Ceiling Enforcement\n');
  }

  // Test 4: Bounded memory retention
  {
    console.log('Test 4: Bounded Tool-Call / Prompt / Hash Retention');
    const state = new MovenRunState({ maxToolCallHistory: 10, maxPromptHistory: 10 });

    for (let i = 0; i < 25; i++) {
      state.recordPrompt(`prompt ${i}`);
      try {
        state.recordToolCall(`tool_${i}`, { i });
      } catch {
        // breaker may trip mid-loop — retention is what we assert
      }
    }
    assert(state.toolCalls.length <= 10, `toolCalls bounded (got ${state.toolCalls.length})`);
    assert(state.prompts.length <= 10, `prompts bounded (got ${state.prompts.length})`);
    assert(state.toolCalls[state.toolCalls.length - 1].toolName === 'tool_24', 'newest entries retained');
    console.log('  ✅ Passed Bounded Retention\n');
  }

  // Test 5: Kill is single-flight — concurrent trippers do not duplicate side effects
  {
    console.log('Test 5: Single-Flight Kill Guard');
    let killCalls = 0;
    const state = new MovenRunState({
      agentName: 'kill-idempotency-agent',
      maxDepth: 1,
      onKill: () => {
        killCalls += 1;
      },
    });

    const trip = {
      tripped: true as const,
      heuristic: 'depth_ceiling' as const,
      reason: 'depth exceeded',
      metrics: state.getMetrics(),
    };

    // Two concurrent kill executions (simulating parallel tool calls)
    const p1 = MovenKillHandler.executeKill(trip, state).catch((e) => e);
    const p2 = MovenKillHandler.executeKill(trip, state).catch((e) => e);
    const [e1, e2] = await Promise.all([p1, p2]);

    assert.strictEqual(killCalls, 1, 'onKill callback fired exactly once');
    assert.strictEqual((e1 as any).name, 'MovenKillError', 'first caller receives kill error');
    assert.strictEqual((e2 as any).name, 'MovenKillError', 'duplicate caller also receives kill error');
    assert.strictEqual(state.isKilled, true);
    console.log('  ✅ Passed Single-Flight Kill\n');
  }

  // Test 6: Telemetry breaker opens after consecutive failures and fail-fasts
  {
    console.log('Test 6: Telemetry Export Self-Protection');
    const originalFetch = globalThis.fetch;
    let fetchAttempts = 0;
    (globalThis as any).fetch = async () => {
      fetchAttempts += 1;
      throw new Error('connection refused');
    };

    try {
      const reporter = new MovenReporter({ apiKey: 'k', endpoint: 'http://localhost:1/events', telemetryFailureThreshold: 2, telemetryCooldownMs: 60_000 });
      const ok1 = await reporter.sendPayload({ event: 'probe', ts: 1 });
      const ok2 = await reporter.sendPayload({ event: 'probe', ts: 2 });

      // Third event hits the open breaker — zero network attempts
      const attemptsBefore = fetchAttempts;
      const ok3 = await reporter.sendPayload({ event: 'probe', ts: 3 });

      assert.strictEqual(ok1, false, 'first failure reported');
      assert.strictEqual(ok2, false, 'second failure reported');
      assert.strictEqual(ok3, false, 'offline event fail-fasts');
      assert.strictEqual(fetchAttempts, attemptsBefore, 'no network attempts while telemetry breaker is open');
    } finally {
      globalThis.fetch = originalFetch;
    }
    console.log('  ✅ Passed Telemetry Self-Protection\n');
  }

  // Test 7: updateOptions inherits the same clamping as the constructor
  {
    console.log('Test 7: Dynamic Policy Updates Are Clamped');
    const state = new MovenRunState({});
    state.updateOptions({ maxDepth: -100, maxCostDollar: NaN } as any);
    assert.strictEqual(state.options.maxDepth, 1, 'dynamic maxDepth clamped');
    assert.strictEqual(state.options.maxCostDollar, 2.00, 'dynamic NaN maxCostDollar clamped');
    console.log('  ✅ Passed Dynamic Update Clamping\n');
  }

  // Test 8: Logger never throws and respects silent mode
  {
    console.log('Test 8: Logger Fail-Safety + Level Control');
    const previousLevel = MovenLogger.getLevel();
    MovenLogger.setTransport(() => {
      throw new Error('broken transport');
    });
    MovenLogger.setLevel('silent' as MovenLogLevel);
    MovenLogger.error('this must not throw');
    MovenLogger.warn('this must not throw either');

    // Restore for remaining suites
    MovenLogger.setTransport(undefined);
    MovenLogger.setLevel(previousLevel);
    console.log('  ✅ Passed Logger Fail-Safety\n');
  }

  console.log('🎉 All Enterprise Hardening Tests Passed!');
}

runHardeningTests().catch((err) => {
  console.error('❌ Hardening test failure:', err);
  process.exit(1);
});
