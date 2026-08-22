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
- ⏪ **Ctrl+Z Step Checkpoints**: Automatically snapshots agent state & prompts before every tool execution for instant time-travel rewinds.
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

## 📜 License

MIT © [Moven AI](https://moven.dev)
