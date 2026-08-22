import assert from 'assert';
import { MovenRunState } from '../src/core/run-state';
import { MovenHeuristicsEngine } from '../src/core/heuristics';
import { wrapToolsWithMoven } from '../src/adapters/vercel-ai-sdk';
import { MovenKillError } from '../src/core/errors';

async function runTests() {
  console.log('🧪 Starting Moven AI Circuit Breaker Heuristics Tests...\n');

  // Test 1: Repeat Call Detection
  {
    console.log('Test 1: Repeat Tool Call Circuit Breaker');
    const state = new MovenRunState({ maxRepeatCalls: 3, repeatTimeWindowMs: 60000 });
    
    // Call same tool 2 times with identical args
    state.recordToolCall('execute_action', { query: 'users' });
    state.recordToolCall('execute_action', { query: 'users' });
    let result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, false, 'Should not trip at 2 calls');

    // 3rd call should trip fuse!
    state.recordToolCall('execute_action', { query: 'users' });
    result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, true, 'Should trip at 3rd repeat call');
    assert.strictEqual(result.heuristic, 'repeat_tool_call');
    console.log('  ✅ Passed Repeat Call Detection\n');
  }

  // Test 2: Cost Ceiling Circuit Breaker
  {
    console.log('Test 2: Cost Ceiling Circuit Breaker');
    const state = new MovenRunState({ maxCostDollar: 1.50 });
    state.addCost(0.80);
    let result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, false);

    state.addCost(0.75); // Total 1.55 > 1.50
    result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, true);
    assert.strictEqual(result.heuristic, 'cost_ceiling');
    console.log('  ✅ Passed Cost Ceiling Detection\n');
  }

  // Test 3: Depth Ceiling Circuit Breaker
  {
    console.log('Test 3: Depth Ceiling Circuit Breaker');
    const state = new MovenRunState({ maxDepth: 5, maxRepeatCalls: 10, enableLlmJudgeArbitrator: false });
    for (let i = 0; i < 6; i++) {
      state.recordToolCall(`unique_tool_name_${i}`, { step: i, random: Math.random() });
    }
    const result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, true);
    assert.strictEqual(result.heuristic, 'depth_ceiling');
    console.log('  ✅ Passed Depth Ceiling Detection\n');
  }

  // Test 4: Vercel AI SDK Tool Wrapper Interception & MovenKillError
  {
    console.log('Test 4: Vercel AI SDK Adapter Tool Interception & Kill Throw');
    let callCount = 0;
    const dummyToolsDiff = {
      update_weather: {
        execute: async (_args: { city: string }) => {
          callCount++;
          return { status: 'recorded', city: _args.city };
        },
      },
    };

    const { tools } = wrapToolsWithMoven(dummyToolsDiff, {
      maxRepeatCalls: 3,
      agentName: 'weather-bot-test',
      enableLlmJudgeArbitrator: false,
      autoFallbackCheaperModel: false, // Disable fallback so trip throws directly
    });

    let caughtError: MovenKillError | null = null;
    try {
      await tools.update_weather.execute({ city: 'San Francisco' });
      await tools.update_weather.execute({ city: 'San Francisco' });
      await tools.update_weather.execute({ city: 'San Francisco' });
    } catch (err: any) {
      if (err instanceof MovenKillError) {
        caughtError = err;
      }
    }

    assert.notStrictEqual(caughtError, null, 'MovenKillError should be thrown');
    assert.strictEqual(caughtError?.heuristic, 'repeat_tool_call');
    assert.strictEqual(caughtError?.toolName, 'update_weather');
    console.log('  ✅ Passed Adapter Interception & MovenKillError Throw\n');
  }

  // Test 4b: Auto-fallback activates instead of throwing when enabled
  {
    console.log('Test 4b: Auto-Fallback Cheaper Model Activation');
    let callCount4b = 0;
    const dummyToolsFallback = {
      sync_data: {
        execute: async (_args: { key: string }) => {
          callCount4b++;
          return { status: 'synced', key: _args.key };
        },
      },
    };

    const { tools: fallbackTools, state: fallbackState } = wrapToolsWithMoven(dummyToolsFallback, {
      maxRepeatCalls: 3,
      agentName: 'fallback-test-agent',
      provider: 'openai',
      currentModel: 'gpt-4o',
      enableLlmJudgeArbitrator: false,
      autoFallbackCheaperModel: true, // Fallback should activate, NOT throw
    });

    let threwKillError = false;
    try {
      await fallbackTools.sync_data.execute({ key: 'user_123' });
      await fallbackTools.sync_data.execute({ key: 'user_123' });
      await fallbackTools.sync_data.execute({ key: 'user_123' });
    } catch (err: any) {
      if (err instanceof MovenKillError) threwKillError = true;
    }

    assert.strictEqual(threwKillError, false, 'Should NOT throw — auto-fallback should activate');
    assert.strictEqual(fallbackState.isFallbackActive, true, 'Fallback should be active');
    assert.strictEqual(fallbackState.activeModel, 'gpt-4o-mini', `Expected gpt-4o-mini, got ${fallbackState.activeModel}`);
    console.log(`  ✅ Passed Auto-Fallback (active model: ${fallbackState.activeModel})\n`);
  }

  // Test 5: No-Progress Turn Hash Detection
  {
    console.log('Test 5: No-Progress Turn Hash Circuit Breaker');
    const state = new MovenRunState({ maxNoProgressTurns: 3, maxRepeatCalls: 10 });
    
    // Simulate 3 consecutive turns with identical output state hash
    const log1 = state.recordToolCall('process_order', { id: 101 });
    state.recordToolResult(log1, { status: 'pending' });

    const log2 = state.recordToolCall('process_order', { id: 101 });
    state.recordToolResult(log2, { status: 'pending' });

    const log3 = state.recordToolCall('process_order', { id: 101 });
    state.recordToolResult(log3, { status: 'pending' });

    const result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, true);
    assert.strictEqual(result.heuristic, 'no_progress_loop');
    console.log('  ✅ Passed No-Progress Turn Hash Detection\n');
  }

  // Test 6: Explicit cheaperModel override always wins
  {
    console.log('Test 6: Explicit cheaperModel Override');
    const state = new MovenRunState({ 
      provider: 'openrouter', 
      modelAuthor: 'openai',
      cheaperModel: 'openai/gpt-5.6-luna-pro' 
    });
    assert.strictEqual(state.getCheaperModel(), 'openai/gpt-5.6-luna-pro');
    console.log('  ✅ Passed Explicit cheaperModel Override\n');
  }

  // ── New Tests: Provider Model Mapping ─────────────────────────────────────

  // Test 7: Native OpenAI provider → bare model ID
  {
    console.log('Test 7: OpenAI provider → bare gpt-4o-mini');
    const state = new MovenRunState({ provider: 'openai', currentModel: 'gpt-4o' });
    const m = state.getCheaperModel();
    assert.strictEqual(m, 'gpt-4o-mini', `Expected gpt-4o-mini, got ${m}`);
    console.log('  ✅ Passed OpenAI bare model mapping\n');
  }

  // Test 8: Native Anthropic provider → bare model ID
  {
    console.log('Test 8: Anthropic provider → bare claude-3-haiku');
    const state = new MovenRunState({ provider: 'anthropic', currentModel: 'claude-3-5-sonnet-20240620' });
    const m = state.getCheaperModel();
    assert.strictEqual(m, 'claude-3-haiku-20240307', `Expected claude-3-haiku-20240307, got ${m}`);
    console.log('  ✅ Passed Anthropic bare model mapping\n');
  }

  // Test 9: Native Google provider → bare model ID
  {
    console.log('Test 9: Google provider → gemini-2.5-flash-lite');
    const state = new MovenRunState({ provider: 'google', currentModel: 'gemini-1.5-pro' });
    const m = state.getCheaperModel();
    assert.strictEqual(m, 'gemini-2.5-flash-lite', `Expected gemini-2.5-flash-lite, got ${m}`);
    console.log('  ✅ Passed Google bare model mapping\n');
  }

  // Test 10: OpenRouter provider → namespaced "author/model" slug
  {
    console.log('Test 10: OpenRouter provider → namespaced openai/gpt-4o-mini');
    const state = new MovenRunState({ provider: 'openrouter', currentModel: 'openai/gpt-4o' });
    const m = state.getCheaperModel();
    assert.strictEqual(m, 'openai/gpt-4o-mini', `Expected openai/gpt-4o-mini, got ${m}`);
    console.log('  ✅ Passed OpenRouter namespaced model mapping\n');
  }

  // Test 11: No provider set — parse author from currentModel slug
  {
    console.log('Test 11: No provider → parse author from currentModel slug');
    const state = new MovenRunState({ currentModel: 'openai/gpt-4o' });
    const m = state.getCheaperModel();
    // No slash-based provider → should return bare name
    assert.strictEqual(m, 'gpt-4o-mini', `Expected gpt-4o-mini, got ${m}`);
    console.log('  ✅ Passed auto-parse author from currentModel\n');
  }

  // Test 12: Groq provider → bare llama model
  {
    console.log('Test 12: Groq provider → bare llama-3.1-8b-instant');
    const state = new MovenRunState({ provider: 'groq', currentModel: 'llama-3.3-70b-versatile' });
    const m = state.getCheaperModel();
    assert.strictEqual(m, 'llama-3.1-8b-instant', `Expected llama-3.1-8b-instant, got ${m}`);
    console.log('  ✅ Passed Groq bare model mapping\n');
  }

  console.log('🎉 ALL HEURISTICS TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
