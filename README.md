# ⚡ Moven AI SDK (`moven-sdk`)

> **The Synchronous Circuit Breaker for Autonomous AI Agents.**
> Real-time, hot-path safety fuses that detect runaway tool loops, parameter repetition, and cost spikes before your credit card burns.

[![npm version](https://img.shields.io/npm/v/moven-sdk.svg?style=flat-square&color=0055FF)](https://www.npmjs.com/package/moven-sdk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)
[![Zero Latency](https://img.shields.io/badge/latency-%3C0.8ms-success.svg?style=flat-square)](#)

---

## 💡 Why Moven?

Observability platforms (LangSmith, Langfuse, Helicone) record what happened **after** your agent finishes. If your agent enters an unhandled 150-step loop at 2 AM, traditional tools show you a $300 bill in the morning.

**Moven sits synchronously in the execution loop**. It evaluates deterministic heuristics in **< 0.8ms** on every tool call and trips the fuse mid-flight before money burns.

---

## ✨ Core Capabilities

- ⚡ **Zero Latency Hot-Path**: In-memory static heuristics evaluate in `< 0.8ms` without network proxies.
- 🔁 **Deep Canonical Parameter Hashing**: SHA-256 canonical JSON serialization detects duplicate parameter loops regardless of object key order.
- 💸 **Dynamic Live Pricing Engine**: Real-time token math synced from `https://api.moven.dev/v1/models` calculates exact dollar savings when loops are intercepted.
- 🛡️ **Zero-Trust Hallucination Guard**: Intercepts unpopulated placeholder arguments (`TODO_...`, `REPLACE_ME`) and non-existent schema parameters.
- ⏪ **Honest Rewind (Ctrl+Z)**: Automatically snapshots the full in-process orchestration state (context, scratchpad, retry counters, conversation history) before every tool execution. Rewind restores it by pointer swap, cancels queued/in-flight calls, runs registered saga compensations for committed calls, returns a durable receipt, and **halts** with the offending tool on a cooldown.
- 🤖 **Multi-Model Dynamic Auto-Fallback**: Automatically falls back to cheaper models (e.g. GPT-4o ➔ Gemini 2.5 Flash Lite) during loops.
- 🌐 **15+ Provider & Framework Adapters**: First-class support for OpenAI, Anthropic Claude, Google Gemini, LangChain, LangGraph, Vercel AI SDK, CrewAI, AutoGen, LlamaIndex, Groq, Mistral, AWS Bedrock, Azure OpenAI, and Ollama.

---

## 📦 Installation

```bash
npm install moven-sdk
# or
pnpm add moven-sdk
# or
yarn add moven-sdk
```

---

## 🚀 Quick Start Examples

### 1. Vercel AI SDK (`ai`)

```typescript
import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { wrapToolsWithMoven } from 'moven-sdk';
import { z } from 'zod';

const tools = wrapToolsWithMoven({
  searchDatabase: tool({
    description: 'Query database',
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      return await db.query(query);
    },
  }),
}, {
  maxRepeatCalls: 3,         // Trip fuse after 3 identical tool calls
  maxCostDollar: 2.00,       // Trip fuse if cumulative run cost exceeds $2.00
  maxDepth: 15,              // Max recursion turn limit
  currentModel: 'openai/gpt-4o',
  agentName: 'production-sql-agent',
});

// Run agent safely
const result = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'Analyze sales drop in Q3',
});
```

---

### 2. LangChain & LangGraph

```typescript
import { wrapLangChainTools } from 'moven-sdk';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

const myTool = new DynamicStructuredTool({
  name: 'fetch_user_orders',
  description: 'Fetches orders for a customer ID',
  schema: z.object({ customerId: z.string() }),
  func: async ({ customerId }) => { /* ... */ },
});

const safeTools = wrapLangChainTools([myTool], {
  agentName: 'customer_support_graph',
  maxRepeatCalls: 3,
  maxCostDollar: 1.50,
});
```

---

### 3. OpenAI Node SDK

```typescript
import OpenAI from 'openai';
import { wrapOpenAIToolRunner } from 'moven-sdk';

const openai = new OpenAI();

const safeTools = wrapOpenAIToolRunner({
  get_balance: async ({ accountId }) => {
    return { balance: 4250.00 };
  }
}, {
  agentName: 'finance_agent',
  currentModel: 'openai/gpt-4o',
});
```

---

### 4. Dynamic Live Model Pricing & Dollar Savings

```typescript
import { MovenDynamicPricingEngine } from 'moven-sdk';

// 0ms synchronous lookup from in-memory cache synced with OpenRouter
const rates = MovenDynamicPricingEngine.getModelRates('anthropic/claude-3.5-sonnet');
console.log(`Claude Sonnet Input Rate: $${rates.promptPerMillion}/1M tokens`);

// Exact dollar savings calculation on tripped loops
const savings = MovenDynamicPricingEngine.calculateMoneySaved({
  modelName: 'openai/gpt-4o',
  totalToolCallsMade: 4,
});

console.log(`Prevented $${savings.moneySaved} USD (${savings.totalPreventedTokens} tokens saved)`);
```

---

## ⏪ Honest Rewind (`MovenRewindEngine`)

Rewind gives a real guarantee by separating what it *can* undo from what it *cannot*:

1. **Restores in-process orchestration state only** — context, scratchpad, retry counters, conversation pointer. Always safe. Checkpoints are immutable deep copies captured before every tool call (a few KB of JSON, sub-millisecond) with a bounded retention window.
2. **Cancels anything queued / in-flight** that hasn't committed yet.
3. **Runs registered compensating actions (saga)** for each call that committed since the checkpoint. No inverse registered → the call is listed explicitly as *executed, not reversed*. It never pretends.
4. **Returns a receipt, not a toast** — N fully reversed, M never executed, K needing manual review, with the explicit list.
5. **Halts.** No auto-resume into the same loop. The offending tool goes on a cooldown so it cannot retrigger the identical loop; resuming requires a human decision or a re-plan.

```typescript
import { MovenRunState, MovenRewindEngine } from 'moven-sdk';

const state = new MovenRunState({
  agentName: 'payments-agent',
  // Saga: register an inverse alongside the protected tool
  compensations: {
    create_row: (args, result) => db.delete_row(result.id),            // in-process handler
    'stripe.charge': { type: 'api_call', name: 'stripe.refund_charge' } // declarative (stored in DB)
  },
});

state.registerCompensation('send_email', { type: 'manual', name: 'manual_email_recall' });

// ... after the breaker trips:
const receipt = await MovenRewindEngine.rewind(state, reporter, { checkpointKey: 'ckpt_turn_2' });
// receipt.fullyReversed, receipt.neverExecuted, receipt.needsManualReview,
// receipt.halted === true, receipt.cooldownUntil

// Operator decision on the halted run (offending tool stays on cooldown across a re-plan):
MovenRewindEngine.resolve(state, 'replan');   // or 'resume' | 'discard'
```

With the Vercel AI SDK adapter you can also declare the inverse inline:

```typescript
const { tools, state, rewind, resolveHalt } = createMovenCircuitBreaker({ agentName: 'feature-tester-08' });
// tools: { createRow: tool({ ..., execute: fn, compensate: (args, result) => db.delete_row(result.id) }) }
const receipt = await rewind({ checkpointKey: 'ckpt_turn_2' });
```

Every wrapped call carries a generated **idempotency key** (`mvn_<run>_<tool>_<depth>_<hash>`) injected into args, so a post-rewind retry can never double-fire the same charge downstream.

---

## 🛠️ Supported Framework Adapters

| Provider / Framework | Exported Adapter |
| :--- | :--- |
| **Vercel AI SDK** | `wrapToolsWithMoven(tools, options)` |
| **LangChain / LangGraph** | `wrapLangChainTools(tools, options)` |
| **OpenAI Node SDK** | `wrapOpenAIToolRunner(tools, options)` |
| **Anthropic Claude** | `wrapAnthropicToolUse(tools, options)` |
| **CrewAI** | `wrapCrewAITools(tools, options)` |
| **AutoGen** | `wrapAutoGenTools(tools, options)` |
| **LlamaIndex** | `wrapLlamaIndexTools(tools, options)` |
| **Google Gemini** | `wrapGoogleGeminiTools(tools, options)` |
| **Groq SDK** | `wrapGroqTools(tools, options)` |
| **Mistral AI** | `wrapMistralTools(tools, options)` |
| **AWS Bedrock / Azure OpenAI** | `wrapBedrockTools(tools, options)`, `wrapAzureOpenAITools(tools, options)` |
| **Custom Function Tools** | `wrapCustomTool(name, fn, options)` |

---

## ⚙️ Configuration Schema (`moven.config.ts`)

```typescript
import { createMovenCircuitBreaker } from 'moven-sdk';

export const moven = createMovenCircuitBreaker({
  agentId: 'agent_inventory_prod_01',
  agentName: 'inventory_agent',
  framework: 'LangGraph',
  
  maxRepeatCalls: 3,               // Max identical tool calls in window (default: 3)
  repeatTimeWindowMs: 60000,       // Window duration in ms (default: 60000)
  maxCostDollar: 2.00,            // Max cost ceiling in USD (default: $2.00)
  maxDepth: 15,                    // Max total tool execution depth (default: 15)
  maxNoProgressTurns: 3,           // Max consecutive identical turn state hashes (default: 3)
  
  currentModel: 'openai/gpt-4o',
  cheaperModel: 'openai/gpt-4o-mini',
  autoFallbackCheaperModel: true,
  enableLlmJudgeArbitrator: true,

  apiKey: process.env.MOVEN_API_KEY,
  endpoint: 'https://api.moven.dev/events',
});
```

---

## 💬 Community & Support

- **Discord**: [Join the Moven Discord Community](https://discord.gg/Um6naf4c6Y)
- **Twitter / X**: [@movendev](https://x.com/movendev)
- **Website**: [moven.dev](https://moven.dev)

---

## 📜 License

MIT © [Moven AI](https://moven.dev)
