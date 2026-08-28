import assert from 'assert';
import { MovenRunState } from '../src/core/run-state';
import { MovenRewindEngine, RewindReceipt } from '../src/core/rewind';
import { MovenKillError } from '../src/core/errors';

async function runRewindTests() {
  console.log('🧪 Starting Honest Rewind Engine Tests...\n');

  // Test 1: Rewind restores in-process orchestration state (context, scratchpad, retry counts)
  {
    console.log('Test 1: Pointer restoration of orchestration state');
    const state = new MovenRunState({ agentName: 'feature-tester-08', autoInjectIdempotencyKey: true });

    state.updateContext({ plan: 'refund flow', step: 1 });
    state.updateScratchpad({ attempt: 1 });
    state.incrementRetry('stripe.refund_transfer');

    const log1 = state.recordToolCall('get_payment', { id: 'pay_1' });
    state.recordToolResult(log1, { status: 'ok' }, 5);
    const ckpt = state.checkpointManager.getLatest()!; // checkpoint BEFORE get_payment executed? No — created during recordToolCall

    // Mutate state after checkpoint
    state.updateContext({ plan: 'refund flow', step: 99, corrupted: true });
    state.updateScratchpad({ attempt: 42 });
    state.incrementRetry('stripe.refund_transfer');

    const receipt = await MovenRewindEngine.rewind(state, undefined, { checkpointStep: ckpt.stepIndex, report: false });
    assert.ok(receipt, 'Receipt should be returned');
    assert.strictEqual(state.context.step, 1, 'Context restored to checkpoint value');
    assert.strictEqual(state.context.corrupted, undefined, 'Post-checkpoint context mutation rolled back');
    assert.strictEqual(state.scratchpad.attempt, 1, 'Scratchpad restored');
    assert.strictEqual(state.retryCounts['stripe.refund_transfer'], 1, 'Retry counters restored');
    assert.strictEqual(receipt!.restored.context && receipt!.restored.scratchpad && receipt!.restored.retryCounts, true);
    console.log('  ✅ Orchestration state restored via pointer rewind\n');
  }

  // Test 2: Cancel queued/in-flight + compensation saga + manual review listing
  {
    console.log('Test 2: Saga compensations, cancellations, manual review');
    const state = new MovenRunState({ agentName: 'payments-agent' });
    const compensationsRan: string[] = [];

    state.registerCompensation('create_row', (args: any, result: any) => {
      compensationsRan.push(`delete:${result.id}`);
      return { deleted: result.id };
    });
    // stripe.charge has NO inverse — must land in manual review
    // send_email registered as explicitly manual
    state.registerCompensation('send_email', { type: 'manual', name: 'manual_email_recall' });

    const c1 = state.recordToolCall('get_customer', { id: 'c_1' });
    state.recordToolResult(c1, { id: 'c_1' }, 3);

    // ckpt_step_2 = captured immediately BEFORE create_row executes — the
    // "last known good state" an operator would pick in the dashboard.
    const ckptStep = 2;

    // After checkpoint: one committed write WITH inverse, one write WITHOUT inverse,
    // one queued (never executed), one in-flight (never executed)
    const w1 = state.recordToolCall('create_row', { data: 'x' });
    state.recordToolResult(w1, { id: 'row_9' }, 4);
    const w2 = state.recordToolCall('stripe.charge', { amount: 842.0 });
    state.recordToolResult(w2, { id: 'ch_1' }, 6);
    state.queueToolCall('stripe.refund_transfer', { amount: 842.0 });
    const w4 = state.recordToolCall('search_tickets', { q: 'loop' });
    // w4 stays in_flight (no result recorded)

    const receipt = await MovenRewindEngine.rewind(state, undefined, { checkpointStep: ckptStep, report: false, offendingTool: 'stripe.refund_transfer' });

    assert.strictEqual(receipt!.fullyReversed, 1, 'create_row should be fully reversed');
    assert.strictEqual(receipt!.neverExecuted, 2, 'queued + in-flight should be cancelled, never executed');
    assert.strictEqual(receipt!.needsManualReview.length, 1, 'stripe.charge needs manual review');
    assert.deepStrictEqual(compensationsRan, ['delete:row_9'], 'Compensating handler ran with (args, result)');
    assert.strictEqual(receipt!.outcomes.find(o => o.toolName === 'stripe.charge')!.detail.includes('no compensating action'), true, 'No-inverse call listed explicitly');

    // Halt + cooldown semantics
    assert.strictEqual(receipt!.halted, true);
    assert.strictEqual(state.halted, true);
    assert.ok(state.cooldownRemainingMs('stripe.refund_transfer') > 0, 'Offending tool on cooldown');

    // Interception guard: halted agent cannot execute anything
    let blockedAsHalted = false;
    try {
      state.recordToolCall('anything', {});
    } catch (e) {
      blockedAsHalted = e instanceof MovenKillError;
    }
    assert.strictEqual(blockedAsHalted, true, 'Halted agent blocks new tool calls BEFORE execution');

    // Operator resolves with re-plan; cooldown must still block the offending tool
    MovenRewindEngine.resolve(state, 'replan');
    assert.strictEqual(state.halted, false);
    assert.strictEqual(state.replanRequested, true);
    let blockedByCooldown = false;
    try {
      state.recordToolCall('stripe.refund_transfer', { amount: 842.0 });
    } catch (e) {
      blockedByCooldown = e instanceof MovenKillError && e.reason.includes('cooldown');
    }
    assert.strictEqual(blockedByCooldown, true, 'Offending tool blocked by cooldown even after re-plan');

    // Different tool works again
    const ok = state.recordToolCall('search_tickets', { q: 'other' });
    assert.ok(ok, 'Non-cooldown tool executes after re-plan');
    console.log('  ✅ Saga reversed 1, cancelled 2, flagged 1 manual review; halt + cooldown enforced\n');
  }

  // Test 3: Idempotency keys auto-injected into args
  {
    console.log('Test 3: Idempotency key injection');
    const state = new MovenRunState({ agentName: 'idem-agent' });
    const log = state.recordToolCall('stripe.charge', { amount: 100 });
    assert.ok(log.idempotencyKey, 'Idempotency key generated');
    assert.strictEqual((log.args as any).idempotency_key, log.idempotencyKey, 'Key injected into args for downstream API');
    console.log('  ✅ Idempotency key auto-generated and injected\n');
  }

  // Test 4: Checkpoint retention window is bounded
  {
    console.log('Test 4: Checkpoint retention window');
    const state = new MovenRunState({ agentName: 'retention-agent', maxCheckpoints: 5 });
    for (let i = 0; i < 20; i++) {
      const l = state.recordToolCall(`tool_${i}`, { i });
      state.recordToolResult(l, { i }, 1);
    }
    assert.ok(state.checkpointManager.getCheckpoints().length <= 5, 'Retention window respected');
    console.log('  ✅ Checkpoint ledger bounded to retention window\n');
  }

  console.log('🎉 All rewind engine tests passed!');
}

runRewindTests().catch(err => {
  console.error('❌ Rewind test failure:', err);
  process.exit(1);
});
