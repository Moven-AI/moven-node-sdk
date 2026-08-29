import assert from 'assert';
import { createMovenLangGraphGuard, withMovenWarnings, buildWarningText, wrapModelWithMoven } from '../src/adapters/langgraph';
import { MovenRunState } from '../src/core/run-state';

/**
 * Pre-trip model warning flow (LangGraph guard):
 *  1. A repeat pattern one call away from the limit queues a warning
 *  2. The wrapped MODEL receives the warning injected into its next invocation
 *  3. Warnings are drained (injected exactly once) and deduplicated
 *  4. Ignoring the warning still results in a hard MovenKillError
 *  5. withMovenWarnings is pure and framework-agnostic
 */

async function runLangGraphWarningTests() {
  console.log('🧪 Starting LangGraph Pre-Trip Warning Tests...\n');

  // Test 1: Warning zone queues a warning; wrapped model receives it
  {
    console.log('Test 1: Wrapped Model Receives Pre-Trip Warning');
    const guard = createMovenLangGraphGuard({
      agentName: 'lg-warning-agent',
      maxRepeatCalls: 3,
      maxNoProgressTurns: 99, // isolate the repeat-warning zone
      warnBeforeTrip: true,
      autoFallbackCheaperModel: false,
    });

    // Simulate a repeat pattern: 2 identical calls (limit 3 → warning zone at 2)
    const { MovenHeuristicsEngine } = await import('../src/core/heuristics');
    for (let i = 0; i < 2; i++) {
      const log = guard.state.recordToolCall('process_data', { dataset: 'tesla-q3' });
      guard.state.recordToolResult(log, { rows: 42 }, 50);
      MovenHeuristicsEngine.evaluate(guard.state);
    }

    assert.strictEqual(guard.state.peekWarnings().length, 1, 'warning queued in the pre-trip zone');
    assert.strictEqual(guard.state.peekWarnings()[0].heuristic, 'repeat_tool_call');

    // The wrapped model must receive the warning on its next invocation
    const captured: any[] = [];
    const fakeModel = {
      modelName: 'gpt-4o',
      async invoke(messages: any[]) {
        captured.push(messages);
        return { content: 'ok' };
      },
    };
    const wrapped = guard.wrapModel(fakeModel);
    await (wrapped as any).invoke([{ role: 'user', content: 'continue' }]);

    assert.strictEqual(captured.length, 1);
    const last = captured[0][captured[0].length - 1];
    assert.strictEqual(last.role, 'system');
    assert.ok(last.content.includes('MOVEN CIRCUIT BREAKER WARNING'), 'warning text injected');
    assert.ok(last.content.includes("'process_data'"), 'warning names the offending tool');
    assert.strictEqual(guard.state.peekWarnings().length, 0, 'warnings drained after injection');
    console.log('  ✅ Warning injected into model invocation, then drained\n');
  }

  // Test 2: Warnings are deduplicated and injected exactly once
  {
    console.log('Test 2: Warning Deduplication');
    const guard = createMovenLangGraphGuard({ maxRepeatCalls: 3, maxNoProgressTurns: 99, warnBeforeTrip: true, autoFallbackCheaperModel: false });
    const { MovenHeuristicsEngine } = await import('../src/core/heuristics');
    for (let i = 0; i < 2; i++) {
      const log = guard.state.recordToolCall('process_data', { dataset: 'tesla-q3' });
      guard.state.recordToolResult(log, { rows: 42 }, 50);
      MovenHeuristicsEngine.evaluate(guard.state);
    }
    // Re-evaluate without any new call — no duplicate warning
    MovenHeuristicsEngine.evaluate(guard.state);
    MovenHeuristicsEngine.evaluate(guard.state);
    assert.strictEqual(guard.state.peekWarnings().length, 1, 'same pattern must not double-warn');
    console.log('  ✅ Deduplicated\n');
  }

  // Test 3: Ignoring the warning still ends in a hard kill
  {
    console.log('Test 3: Hard Kill Still Fires When Warning Ignored');
    const guard = createMovenLangGraphGuard({ maxRepeatCalls: 3, maxNoProgressTurns: 99, warnBeforeTrip: true, autoFallbackCheaperModel: false });
    const { MovenHeuristicsEngine } = await import('../src/core/heuristics');
    let killed = false;
    for (let i = 0; i < 3; i++) {
      const log = guard.state.recordToolCall('process_data', { dataset: 'tesla-q3' });
      guard.state.recordToolResult(log, { rows: 42 }, 50);
      const result = MovenHeuristicsEngine.evaluate(guard.state);
      if (result.tripped) {
        killed = result.heuristic === 'repeat_tool_call';
        break;
      }
    }
    assert.strictEqual(killed, true, 'breaker must trip when the model ignores the warning');
    console.log('  ✅ Kill preserved\n');
  }

  // Test 4: withMovenWarnings is pure (input array untouched)
  {
    console.log('Test 4: withMovenWarnings Purity');
    const state = new MovenRunState({});
    state.pushWarning({ heuristic: 'no_progress_loop', remaining: 1, message: 'test warning message' });
    const original = [{ role: 'user', content: 'hello' }];
    const warned = withMovenWarnings(state, original);
    assert.strictEqual(original.length, 1, 'input array must not be mutated');
    assert.strictEqual(warned.length, 2);
    assert.ok(warned[1].content.includes('test warning message'));
    assert.strictEqual(withMovenWarnings(state, original).length, 1, 'drained → no double injection');
    console.log('  ✅ Pure injection\n');
  }

  // Test 5: Function-style models and string prompts also get warnings
  {
    console.log('Test 5: Function-Style Model + String Prompt');
    const state = new MovenRunState({});
    state.pushWarning({ heuristic: 'repeat_tool_call', toolName: 'fetch_page', remaining: 1, message: 'stop refetching' });
    const calls: string[] = [];
    const model = async (prompt: string) => {
      calls.push(prompt);
      return 'done';
    };
    const wrapped = wrapModelWithMoven(model, state);
    await (wrapped as any)('continue the task');
    assert.ok(calls[0].includes('MOVEN CIRCUIT BREAKER WARNING'));
    assert.ok(calls[0].includes('stop refetching'));
    console.log('  ✅ Function-model wrapping works\n');
  }

  // Test 6: Warning text is well-formed
  {
    console.log('Test 6: Warning Text Format');
    const text = buildWarningText([
      { id: '1', heuristic: 'repeat_tool_call', toolName: 'search_web', remaining: 1, message: 'called 2 times', createdAt: Date.now() },
    ]);
    assert.ok(text.includes('[MOVEN CIRCUIT BREAKER WARNING]'));
    assert.ok(text.includes('repeat_tool_call'));
    assert.ok(text.includes("search_web"));
    assert.ok(text.toLowerCase().includes('halt'));
    console.log('  ✅ Format verified\n');
  }

  // Test 7: UNIVERSAL SURFACE — createMovenCircuitBreaker().warnModel works
  // with ANY framework (OpenAI SDK, Anthropic, CrewAI, AutoGen, LlamaIndex…)
  {
    console.log('Test 7: Any-SDK warnModel Surface');
    const { createMovenCircuitBreaker } = await import('../src/adapters/vercel-ai-sdk');
    const breaker = createMovenCircuitBreaker({ agentName: 'any-sdk-agent' });
    breaker.state.pushWarning({ heuristic: 'repeat_tool_call', toolName: 'run_report', remaining: 1, message: 'vary your approach' });

    // OpenAI-SDK style usage: messages.map → warnModel right before create()
    const messages = [{ role: 'user', content: 'continue' }];
    const warned = breaker.warnModel(messages);
    assert.strictEqual(messages.length, 1, 'input untouched');
    assert.strictEqual(warned[warned.length - 1].role, 'system');
    assert.ok(warned[warned.length - 1].content.includes("run_report"));
    assert.strictEqual(breaker.peekWarnings().length, 0, 'drained after injection');
    assert.strictEqual(breaker.warnModel(messages).length, 1, 'no warnings left → passthrough');
    console.log('  ✅ Universal warnModel verified\n');
  }

  console.log('🎉 All LangGraph Pre-Trip Warning Tests Passed!');
}

runLangGraphWarningTests().catch((err) => {
  console.error('❌ LangGraph warning test failure:', err);
  process.exit(1);
});
