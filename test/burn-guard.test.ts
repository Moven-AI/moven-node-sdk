import assert from 'assert';
import { MovenRunState } from '../src/core/run-state';
import { MovenOvernightBurnGuard } from '../src/core/burn-guard';
import { MovenSemanticCacheEngine } from '../src/core/semantic-cache';
import { MovenCheckpointManager } from '../src/core/checkpoint';
import { MovenHeuristicsEngine } from '../src/core/heuristics';

async function runBurnGuardAndCacheTests() {
  console.log('🧪 Starting Overnight Burn Guard, Semantic Cache & Checkpoint Tests...\n');

  // Test 1: Overnight Burn Guard Hourly Spend Velocity Limit
  {
    console.log('Test 1: Overnight Burn Guard Hourly Spend Velocity Limit');
    const state = new MovenRunState({
      burnGuard: { maxHourlySpendDollar: 5.00, isEnabled: true }
    });

    state.addCost(3.00);
    let check = MovenOvernightBurnGuard.evaluate(state);
    assert.strictEqual(check.tripped, false, 'Should not trip at $3.00');

    state.addCost(2.50); // Total $5.50 > $5.00
    check = MovenOvernightBurnGuard.evaluate(state);
    assert.strictEqual(check.tripped, true, 'Should trip at $5.50 hourly spend');
    assert.strictEqual(check.guardType, 'hourly_velocity_exceeded');
    console.log('  ✅ Passed Hourly Spend Velocity Limit\n');
  }

  // Test 2: Wall-Clock Max Duration Ceiling
  {
    console.log('Test 2: Wall-Clock Max Run Duration Ceiling');
    const state = new MovenRunState({
      burnGuard: { maxRunDurationMinutes: 0.0001, isEnabled: true } // 6 milliseconds
    });

    // Wait 20ms to ensure duration exceeded
    await new Promise(r => setTimeout(r, 25));

    const check = MovenOvernightBurnGuard.evaluate(state);
    assert.strictEqual(check.tripped, true, 'Should trip max run duration ceiling');
    assert.strictEqual(check.guardType, 'max_duration_exceeded');
    console.log('  ✅ Passed Wall-Clock Max Duration Ceiling\n');
  }

  // Test 3: Semantic Cache Local Lookup & Cosine Token Match
  {
    console.log('Test 3: Semantic Cache Store & Fast Similarity Lookup');
    MovenSemanticCacheEngine.clearMemoryCache();

    MovenSemanticCacheEngine.store(
      'search inventory database for widget X',
      { status: 'success', inStock: 42 },
      0.02,
      { enableSemanticCache: true }
    );

    // Semantically equivalent query (different order / capitalization)
    const res = MovenSemanticCacheEngine.lookup(
      'SEARCH inventory database for WIDGET X',
      { enableSemanticCache: true, similarityThreshold: 0.85 }
    );

    assert.strictEqual(res.hit, true, 'Should get semantic cache hit');
    assert.strictEqual(res.cachedResponse.inStock, 42);
    assert.ok(res.similarity! >= 0.85);
    console.log(`  ✅ Passed Semantic Cache Lookup (similarity: ${res.similarity}, saved: $${res.costSavedDollar})\n`);
  }

  // Test 4: Ctrl+Z Step Checkpoint Manager Snapshot & Rewind
  {
    console.log('Test 4: Ctrl+Z Step Checkpoint Manager Snapshot & Rewind');
    const manager = new MovenCheckpointManager();

    manager.createCheckpoint('trace_101', 'agent_a', 1, 'tool_search', { q: 'apples' }, 0.01);
    manager.createCheckpoint('trace_101', 'agent_a', 2, 'tool_filter', { minPrice: 10 }, 0.02);
    manager.createCheckpoint('trace_101', 'agent_a', 3, 'tool_checkout', { cartId: 99 }, 0.05);

    let checkpoints = manager.getCheckpoints();
    assert.strictEqual(checkpoints.length, 3);

    // Rewind back to step 2
    const target = manager.rewindToStep(2);
    assert.strictEqual(target?.stepIndex, 2);
    assert.strictEqual(target?.lastToolCalled, 'tool_filter');

    // Future checkpoint at step 3 should be truncated
    checkpoints = manager.getCheckpoints();
    assert.strictEqual(checkpoints.length, 2);
    console.log('  ✅ Passed Ctrl+Z Step Snapshot & Rewind\n');
  }

  console.log('🎉 ALL BURN GUARD & SEMANTIC CACHE TESTS PASSED SUCCESSFULLY!');
}

runBurnGuardAndCacheTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
