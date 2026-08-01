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
    state.recordToolCall('search_db', { query: 'users' });
    state.recordToolCall('search_db', { query: 'users' });
    let result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, false, 'Should not trip at 2 calls');

    // 3rd call should trip fuse!
    state.recordToolCall('search_db', { query: 'users' });
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
    const dummyTools = {
      query_weather: {
        execute: async (args: { city: string }) => {
          return { temp: '72F', city: args.city };
        },
      },
    };

    const { tools } = wrapToolsWithMoven(dummyTools, {
      maxRepeatCalls: 3,
      agentName: 'weather-bot-test',
    });

    let caughtError: MovenKillError | null = null;
    try {
      // Execute 3 repeat calls
      await tools.query_weather.execute({ city: 'San Francisco' });
      await tools.query_weather.execute({ city: 'San Francisco' });
      await tools.query_weather.execute({ city: 'San Francisco' });
    } catch (err: any) {
      if (err instanceof MovenKillError) {
        caughtError = err;
      }
    }

    assert.notStrictEqual(caughtError, null, 'MovenKillError should be thrown');
    assert.strictEqual(caughtError?.heuristic, 'repeat_tool_call');
    assert.strictEqual(caughtError?.toolName, 'query_weather');
    console.log('  ✅ Passed Adapter Interception & MovenKillError Throw\n');
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

  // Test 6: Cheaper Model Resolution & OpenRouter Mapping
  {
    console.log('Test 6: Cheaper Fallback Model Resolution');
    const state = new MovenRunState({ 
      provider: 'openrouter', 
      modelAuthor: 'openai',
      cheaperModel: 'openai/gpt-5.6-luna-pro' 
    });

    const cheaperModel = state.getCheaperModel();
    assert.strictEqual(cheaperModel, 'openai/gpt-5.6-luna-pro');
    console.log('  ✅ Passed Cheaper Fallback Model Resolution\n');
  }

  console.log('🎉 ALL HEURISTICS TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
