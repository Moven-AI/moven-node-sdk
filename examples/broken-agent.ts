import { createMovenCircuitBreaker, MovenKillError } from '../src';

// Deliberately broken agent loop simulation
async function runBrokenAgentLoop() {
  console.log('🤖 Starting Broken Agent Simulation...');
  console.log('Problem: Agent gets stuck in a loop calling check_inventory with identical SKU\n');

  // Initialize Moven Circuit Breaker
  const breaker = createMovenCircuitBreaker({
    agentName: 'inventory-sync-agent',
    maxRepeatCalls: 4,     // Trip on 4th repeat call
    maxCostDollar: 1.00,   // Trip if cost exceeds $1.00
    maxDepth: 10,
    onKill: (err) => {
      console.log(`🚨 [Circuit Breaker Alert] Tripped by rule: '${err.heuristic}'`);
      console.log(`   Reason: ${err.reason}`);
      console.log(`   Estimated Money Saved: $${(15.50 - err.metrics.totalCost).toFixed(2)} (Prevented ~100 runaway loop calls)`);
    },
  });

  // Tools provided to agent
  const rawTools = {
    check_inventory: {
      estimatedCost: 0.05,
      execute: async (args: { sku: string }) => {
        console.log(`  🔨 Tool Executed: check_inventory(sku: "${args.sku}")`);
        return { status: 'out_of_stock', sku: args.sku };
      },
    },
  };

  const safeTools = breaker.wrapTools(rawTools);

  // Simulate agent loop (without Moven, this loop would execute 100 times and burn $5.00+)
  try {
    for (let i = 1; i <= 20; i++) {
      console.log(`\n--- Step ${i}: Agent decision ---`);
      // Agent repeatedly decides to call check_inventory with the same SKU
      await safeTools.check_inventory.execute({ sku: 'PROD-9982' });
    }
  } catch (error) {
    if (error instanceof MovenKillError) {
      console.log('\n✅ SUCCESS: Moven AI caught the runaway loop and killed execution mid-flight!');
      console.log(`   Error Type: ${error.name}`);
      console.log(`   Run ID: ${error.runId}`);
      console.log(`   Offending Tool: ${error.toolName}`);
      console.log(`   Total Tool Calls Allowed: ${error.metrics.totalToolCalls}`);
      console.log(`   Final Cost Incurred: $${error.metrics.totalCost.toFixed(2)}`);
    } else {
      console.error('Unexpected error:', error);
    }
  }
}

runBrokenAgentLoop();
