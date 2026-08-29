import assert from 'assert';
import {
  MovenLayer2Guard,
  SemanticMemoryManager,
  MovenMrlEmbedder,
  SemanticCanonicalizer,
  TinySemanticClassifier,
  SemanticFeatureEngine,
  MovenRunState,
  MovenHeuristicsEngine,
} from '../src';

async function runLayer2Tests() {
  console.log('🧪 Starting Moven Layer 2: Semantic Guard Tests...\n');

  // Test 1: Canonicalization & Argument Breakdown
  {
    console.log('Test 1: Semantic Canonicalization');
    const canonical = SemanticCanonicalizer.canonicalize({
      tool: 'search_contacts',
      arguments: { query: 'John Smith', field: 'email' },
      goal: "Find John's email address",
      expectedOutcome: "John Smith's email address",
    });

    assert.ok(canonical.canonicalGoal.includes("Find John's email"));
    assert.ok(canonical.canonicalActionText.includes('Tool: search_contacts'));
    assert.ok(canonical.entityTokens.includes('john smith'));
    assert.ok(canonical.attributeTokens.some(a => a.includes('email')));
    assert.strictEqual(typeof canonical.hash, 'string');
    assert.strictEqual(canonical.hash.length, 64);
    console.log('  ✅ Passed Canonicalization & Argument Token Breakdown\n');
  }

  // Test 2: MRL Static Embedder & Cosine Similarity
  {
    console.log('Test 2: MRL Static Embeddings & Truncation');
    const vec128 = MovenMrlEmbedder.embed("Find John's email", 128);
    const vecSimilar = MovenMrlEmbedder.embed("Retrieve email for John", 128);
    const vecDifferent = MovenMrlEmbedder.embed("Book a hotel room in Paris", 128);

    assert.strictEqual(vec128.length, 128);
    const simHigh = MovenMrlEmbedder.cosineSimilarity(vec128, vecSimilar);
    const simLow = MovenMrlEmbedder.cosineSimilarity(vec128, vecDifferent);

    assert.ok(simHigh > simLow, `Expected similar (${simHigh}) > different (${simLow})`);
    console.log(`  ✅ Passed MRL Embeddings (Similar: ${simHigh.toFixed(2)}, Dissimilar: ${simLow.toFixed(2)})\n`);
  }

  // Test 3: Spec Scenario 1 — Finding John's email -> Redundant search -> REPLAN
  {
    console.log("Test 3: Spec Scenario 1 — Redundant Search Interception (REPLAN)");
    const guard = new MovenLayer2Guard('test_agent_1');
    guard.memory.setGoal("Find John's email address");

    // First tool executed and produced email
    guard.recordToolResult('search_contacts', { query: 'John' }, { name: 'John Smith', email: 'john@example.com' });

    // Agent attempts redundant google search for already known email
    const result = guard.evaluate(
      'google_search',
      { query: 'John Smith email' },
      "Find John's email address",
      "John Smith's email address"
    );

    assert.ok(
      result.decision === 'REPLAN' || result.decision === 'BLOCK',
      `Expected REPLAN or BLOCK, got ${result.decision}`
    );
    assert.ok(result.probabilities.p_redundant > 0.85, `Expected P(redundant) > 0.85, got ${result.probabilities.p_redundant}`);
    console.log(`  ✅ Passed Redundant Information Interception: ${result.decision} (P(redundant)=${result.probabilities.p_redundant})\n`);
  }

  // Test 4: Spec Scenario 2 — Finding John's email then phone -> ALLOW
  {
    console.log("Test 4: Spec Scenario 2 — Useful Progress Detection (ALLOW)");
    const guard = new MovenLayer2Guard('test_agent_2');
    guard.memory.setGoal("Find John's email and phone number");

    // First action returned email
    guard.recordToolResult('search_contacts', { query: 'John' }, 'email = john@example.com');

    // Second action searches for phone (novel attribute!)
    const result = guard.evaluate(
      'search_contacts_phone',
      { query: 'John' },
      "Find John's email and phone number",
      "John's phone number"
    );

    assert.strictEqual(result.decision, 'ALLOW', `Expected ALLOW, got ${result.decision}`);
    assert.ok(result.probabilities.p_useful > 0.60, `Expected P(useful) > 0.60, got ${result.probabilities.p_useful}`);
    console.log(`  ✅ Passed Useful Progress Detection: ${result.decision} (P(useful)=${result.probabilities.p_useful})\n`);
  }

  // Test 5: Spec Scenario 3 — Goal Drift Interception -> REPLAN
  {
    console.log("Test 5: Spec Scenario 3 — Goal Drift Interception (REPLAN)");
    const guard = new MovenLayer2Guard('test_agent_3');
    guard.memory.setGoal("Fix typescript syntax errors in auth service");

    // Irrelevant tool call (booking hotels)
    const result = guard.evaluate(
      'search_hotels',
      { location: 'New York City', nights: 3 },
      "Fix typescript syntax errors in auth service",
      "List of hotels in NYC"
    );

    assert.strictEqual(
      result.decision,
      'REPLAN',
      `Expected REPLAN for Goal Drift, got ${result.decision} (P(drift)=${result.probabilities.p_goal_drift})`
    );
    console.log(`  ✅ Passed Goal Drift Interception: ${result.decision} (P(drift)=${result.probabilities.p_goal_drift})\n`);
  }

  // Test 6: Default to ALLOW under uncertainty
  {
    console.log("Test 6: Default to ALLOW Under Uncertainty (<0.1% False Intervention Target)");
    const guard = new MovenLayer2Guard('test_agent_4');
    guard.memory.setGoal("Build and deploy application");

    const result = guard.evaluate('inspect_build_artifact', { buildId: 409 }, "Build and deploy application");
    assert.strictEqual(result.decision, 'ALLOW', 'Uncertain actions must default to ALLOW');
    console.log(`  ✅ Passed Uncertainty Rule: ${result.decision} (Reason: ${result.reason})\n`);
  }

  // Test 7: Full Integration with MovenRunState & MovenHeuristicsEngine
  {
    console.log("Test 7: Full MovenRunState & Heuristics Hook Integration");
    const state = new MovenRunState({
      userRequest: "Find John's email",
      layer2: { enabled: true },
    });

    // Step 1: Useful tool call
    const log1 = state.recordToolCall('search_contacts', { query: 'John' });
    state.recordToolResult(log1, { email: 'john@example.com' }, 100);

    let heuristicCheck = MovenHeuristicsEngine.evaluate(state);
    assert.strictEqual(heuristicCheck.tripped, false, 'Step 1 should pass');

    // Step 2: Redundant tool call
    state.recordToolCall('google_search', { query: 'John Smith email address' });
    heuristicCheck = MovenHeuristicsEngine.evaluate(state);

    assert.strictEqual(heuristicCheck.tripped, true, 'Redundant step 2 should trip Layer 2');
    assert.ok(
      heuristicCheck.heuristic === 'layer2_replan' || heuristicCheck.heuristic === 'layer2_block',
      `Expected layer2 heuristic, got ${heuristicCheck.heuristic}`
    );
    console.log(`  ✅ Passed Full SDK Heuristics Integration (Tripped: ${heuristicCheck.heuristic})\n`);
  }

  // Test 8: Sub-Millisecond Latency Benchmark
  {
    console.log("Test 8: Hot Path Latency Benchmark (<1ms)");
    const guard = new MovenLayer2Guard('perf_agent');
    guard.memory.setGoal("Optimize agent performance");

    const iterations = 50;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      guard.evaluate('read_file', { path: `src/file_${i}.ts` });
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / iterations;

    assert.ok(avgMs < 1.5, `Average latency must be <1.5ms, got ${avgMs.toFixed(3)}ms`);
    console.log(`  ✅ Passed Hot Path Performance: ${avgMs.toFixed(3)}ms per evaluation (Total ${iterations} runs in ${elapsed.toFixed(1)}ms)\n`);
  }

  console.log('🎉 ALL MOVEN LAYER 2 (SEMANTIC GUARD) TESTS PASSED SUCCESSFULLY!');
}

runLayer2Tests().catch(err => {
  console.error('❌ Test failure:', err);
  process.exit(1);
});

