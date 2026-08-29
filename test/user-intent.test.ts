import assert from 'assert';
import { MovenRunState } from '../src/core/run-state';
import { MovenHeuristicsEngine } from '../src/core/heuristics';

/**
 * User-Intent Attestation — "a money saver that knows when to trip".
 *
 * Scenario matrix:
 *  1. Agent loops 5x on its own with identical results  → TRIPS (money saved)
 *  2. User explicitly asks to search 5 times            → NO TRIP (attested)
 *  3. Human-directed spam crosses the stagnation ceiling → TRIPS (waste backstop)
 *  4. Attestation window expires, agent keeps looping    → TRIPS again
 *  5. Cost ceiling is NEVER relaxed by attestation       → TRIPS regardless
 *  6. Human-directed calls with PROGRESSING results      → NO TRIP (real work)
 */

function simulateSearch(state: MovenRunState, query: string, result: any): void {
  const log = state.recordToolCall('search_web', { query });
  state.recordToolResult(log, result, 50);
}

async function runUserIntentTests() {
  console.log('🧪 Starting User-Intent Attestation Tests...\n');

  // Test 1: Agent-initiated loop — 5 identical searches with identical results → trips
  {
    console.log('Test 1: Agent-Initiated Loop Trips');
    const state = new MovenRunState({ maxRepeatCalls: 5 });
    // No user instruction after the initial request → window from ctor expires by
    // faking an old start: simulate by calling with empty userRequest.
    for (let i = 0; i < 5; i++) {
      simulateSearch(state, 'tesla revenue', { revenue: '$96.7B', status: 'ok' });
    }
    const result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, true, 'agent-initiated stagnant loop must trip');
    console.log(`  ✅ Tripped on: ${result.heuristic}\n`);
  }

  // Test 2: User asks to search 5 times → attested → NO trip
  {
    console.log('Test 2: User-Directed Repetition Does NOT Trip');
    const state = new MovenRunState({ maxRepeatCalls: 5, humanAttestationWindowMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      state.recordUserInstruction('search tesla revenue again'); // each user turn re-attests
      simulateSearch(state, 'tesla revenue', { revenue: '$96.7B', status: 'ok' });
      const result = MovenHeuristicsEngine.evaluate(state);
      assert.strictEqual(result.tripped, false, `user-directed call #${i + 1} must not trip`);
    }
    console.log('  ✅ All 5 user-directed identical searches allowed\n');
  }

  // Test 3: Explicit user count ("5 times") sets the exact budget — trips AFTER it
  {
    console.log('Test 3: Explicit Count Budget Extraction');
    const state = new MovenRunState({ maxRepeatCalls: 5, humanAttestationWindowMs: 600_000, maxHumanAttestedStagnantSteps: 12 });
    state.recordUserInstruction('search tesla revenue 5 times');
    // 5 identical results = exactly the user's stated budget → allowed
    for (let i = 0; i < 5; i++) {
      simulateSearch(state, 'tesla revenue', { revenue: '$96.7B', status: 'ok' });
      const result = MovenHeuristicsEngine.evaluate(state);
      assert.strictEqual(result.tripped, false, `call #${i + 1} within the user's stated budget must not trip`);
    }
    // 6th identical result exceeds the stated budget → trips
    simulateSearch(state, 'tesla revenue', { revenue: '$96.7B', status: 'ok' });
    const result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, true, 'budget exhaustion must trip');
    assert.strictEqual(result.heuristic, 'user_directed_ceiling');
    console.log('  ✅ Tripped exactly after the stated budget\n');
  }

  // Test 3b: No explicit count → general waste backstop still applies
  {
    console.log('Test 3b: General Waste Backstop (No Count Given)');
    const state = new MovenRunState({ maxRepeatCalls: 5, humanAttestationWindowMs: 600_000, maxHumanAttestedStagnantSteps: 6 });
    state.recordUserInstruction('search tesla revenue again');
    for (let i = 0; i < 7; i++) {
      simulateSearch(state, 'tesla revenue', { revenue: '$96.7B', status: 'ok' });
    }
    const result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, true, 'waste backstop must trip beyond maxHumanAttestedStagnantSteps');
    assert.strictEqual(result.heuristic, 'user_directed_ceiling');
    console.log('  ✅ Backstop ceiling enforced\n');
  }

  // Test 3c: An UNRELATED mid-run message must NOT attest ("what's their PE ratio?")
  {
    console.log('Test 3c: Unrelated Message Does Not Attest');
    const state = new MovenRunState({ maxRepeatCalls: 5, humanAttestationWindowMs: 600_000 });
    state.recordUserInstruction('search tesla revenue again'); // directive — attests
    simulateSearch(state, 'tesla revenue', { revenue: '$96.7B' });
    state.recordUserInstruction('what is their pe ratio?');    // NOT a directive
    for (let i = 0; i < 5; i++) {
      simulateSearch(state, 'tesla revenue', { revenue: '$96.7B', status: 'ok' });
    }
    const result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, true, 'a non-directive user message must not license repetition');
    console.log(`  ✅ Tripped on: ${result.heuristic}\n`);
  }

  // Test 3d: A stop message ("stop searching") revokes an active attestation
  {
    console.log('Test 3d: Stop Message Revokes Attestation');
    const state = new MovenRunState({ maxRepeatCalls: 5, humanAttestationWindowMs: 600_000 });
    state.recordUserInstruction('search tesla revenue again');
    simulateSearch(state, 'tesla revenue', { revenue: '$96.7B' });
    assert.strictEqual(state.isCallAttested('search_web', { query: 'tesla revenue' }), true, 'attested while directive is active');
    state.recordUserInstruction('stop searching now');
    assert.strictEqual(state.isCallAttested('search_web', { query: 'tesla revenue' }), false, 'stop message must revoke attestation');
    console.log('  ✅ Negation revokes attestation\n');
  }

  // Test 4: Attestation window expires → agent loops → trips
  {
    console.log('Test 4: Expired Attestation Window → Loop Detection Resumes');
    const state = new MovenRunState({ maxRepeatCalls: 5, humanAttestationWindowMs: 60_000 });
    state.recordUserInstruction('search tesla revenue');
    for (let i = 0; i < 5; i++) {
      simulateSearch(state, 'tesla revenue', { revenue: '$96.7B', status: 'ok' });
    }
    // Simulate the window expiring (5 minutes passed since the instruction)
    (state as any).humanAttestUntil = Date.now() - 1;
    simulateSearch(state, 'tesla revenue', { revenue: '$96.7B', status: 'ok' });
    const result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, true, 'once the window expires, looping must trip again');
    console.log(`  ✅ Tripped on: ${result.heuristic}\n`);
  }

  // Test 5: Cost ceiling is NEVER relaxed by attestation
  {
    console.log('Test 5: Hard Cost Ceiling Stays Active Under Attestation');
    const state = new MovenRunState({ maxRepeatCalls: 5, maxCostDollar: 0.05, humanAttestationWindowMs: 600_000 });
    state.recordUserInstruction('keep searching');
    for (let i = 0; i < 3; i++) {
      simulateSearch(state, `tesla revenue v${i}`, { revenue: `${i}B`, status: 'ok' });
    }
    state.cumulativeCost = 0.051; // injected spend over the ceiling
    const result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, true, 'cost ceiling must trip regardless of attestation');
    assert.strictEqual(result.heuristic, 'cost_ceiling');
    console.log('  ✅ Cost ceiling enforced under attestation\n');
  }

  // Test 6: Human-directed calls with PROGRESSING results → real work, no trip
  {
    console.log('Test 6: Progressing Results Under Attestation Are Real Work');
    const state = new MovenRunState({ maxRepeatCalls: 5, humanAttestationWindowMs: 600_000, maxHumanAttestedStagnantSteps: 12 });
    state.recordUserInstruction('poll the build until done');
    for (let i = 0; i < 8; i++) {
      simulateSearch(state, 'build status', { status: 'building', progress: (i + 1) * 10 });
    }
    const result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, false, 'progressing results are legitimate work');
    console.log('  ✅ Progressing human-directed calls allowed\n');
  }

  // Test 7: recordPrompt(role='user') attests MID-RUN (after tool activity)
  {
    console.log('Test 7: Mid-Run User Prompt Re-attests');
    const state = new MovenRunState({ maxRepeatCalls: 5, humanAttestationWindowMs: 60_000 });
    simulateSearch(state, 'report', { rows: 1 }); // some prior agent activity
    (state as any).humanAttestUntil = 0; // expired
    state.recordPrompt('run the report again', 'user');
    simulateSearch(state, 'report', { rows: 1 });
    const log = state.toolCalls[state.toolCalls.length - 1];
    assert.strictEqual(log.humanAttested, true, 'a mid-run user prompt must attest the following calls');
    console.log('  ✅ Mid-run prompt attestation works\n');
  }

  // Test 8: The INITIAL task prompt does NOT attest — Layer 2 stays armed
  // for agent-initiated redundancy within the first turn.
  {
    console.log('Test 8: Initial Prompt Does Not Attest (Layer 2 Stays Armed)');
    const state = new MovenRunState({ maxRepeatCalls: 5, humanAttestationWindowMs: 60_000 });
    state.setUserRequest('search inventory for widgets'); // initial task, no attestation
    for (let i = 0; i < 5; i++) {
      simulateSearch(state, 'inventory widgets', { count: 42, status: 'ok' });
    }
    const result = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(result.tripped, true, 'agent-initiated redundancy in the first turn must still trip');
    console.log(`  ✅ Tripped on: ${result.heuristic}\n`);
  }

  console.log('🎉 All User-Intent Attestation Tests Passed!');
}

runUserIntentTests().catch((err) => {
  console.error('❌ User-intent test failure:', err);
  process.exit(1);
});
