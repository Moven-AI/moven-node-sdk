import assert from 'assert';
import { MovenRunState } from '../src/core/run-state';
import { MovenHallucinationDetector } from '../src/core/hallucination';
import { MovenHeuristicsEngine } from '../src/core/heuristics';

console.log('Running MovenHallucinationDetector unit tests...');

// 1. Invented tool test
{
  const state = new MovenRunState({
    allowedTools: ['search_database', 'read_file'],
  });

  state.recordToolCall('search_database', { query: 'test' });
  let res = MovenHallucinationDetector.evaluate(state);
  assert.strictEqual(res.tripped, false);

  // Agent hallucinates non-existent tool
  state.recordToolCall('query_fake_magic_ai_db', { query: 'magic' });
  res = MovenHallucinationDetector.evaluate(state);

  assert.strictEqual(res.tripped, true);
  assert.strictEqual(res.hallucinationType, 'invented_tool');
  assert.ok(res.reason?.includes('query_fake_magic_ai_db'));
  console.log('  ✓ Invented tool hallucination detected');
}

// 2. Stringified placeholder / undefined parameter test
{
  const state = new MovenRunState();

  state.recordToolCall('update_user', { userId: '123', email: 'test@example.com' });
  let res = MovenHallucinationDetector.evaluate(state);
  assert.strictEqual(res.tripped, false);

  // Agent passes "undefined" string literal as parameter
  state.recordToolCall('update_user', { userId: 'undefined', role: 'admin' });
  res = MovenHallucinationDetector.evaluate(state);

  assert.strictEqual(res.tripped, true);
  assert.strictEqual(res.hallucinationType, 'placeholder_args');
  assert.ok(res.reason?.includes('undefined'));
  console.log('  ✓ Stringified placeholder argument hallucination detected');
}

// 3. Phantom resource pursuit after explicit tool error
{
  const state = new MovenRunState();

  // Tool 1 returns explicit 404 / Not Found error
  state.recordToolCall('fetch_user', { userId: 'usr_abc999' });
  state.recordToolResult({ error: 'User usr_abc999 not found (404)' });

  // Tool 2 hallucinates action on phantom resource usr_abc999
  state.recordToolCall('delete_user', { userId: 'usr_abc999' });
  state.recordToolResult({ error: 'User usr_abc999 not found (404)' });

  state.recordToolCall('send_email_to_user', { userId: 'usr_abc999' });

  const res = MovenHallucinationDetector.evaluate(state);
  assert.strictEqual(res.tripped, true);
  assert.strictEqual(res.hallucinationType, 'phantom_resource');
  assert.ok(res.reason?.includes('usr_abc999'));
  console.log('  ✓ Phantom resource pursuit hallucination detected');
}

// 4. MovenHeuristicsEngine integration
{
  const state = new MovenRunState({
    allowedTools: ['get_weather'],
  });

  state.recordToolCall('nuke_server', { target: '[object Object]' });

  const trip = MovenHeuristicsEngine.evaluate(state);
  assert.strictEqual(trip.tripped, true);
  assert.strictEqual(trip.heuristic, 'ai_hallucination');
  console.log('  ✓ Integrated into MovenHeuristicsEngine circuit breaker');
}

console.log('ALL MovenHallucinationDetector TESTS PASSED! 🎉');
