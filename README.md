# ⚡ Moven AI SDK (`@moven/sdk`)

> **The Synchronous Circuit Breaker for Autonomous AI Agents.**
> Real-time, hot-path safety fuses that detect runaway tool loops, parameter repetition, and cost spikes before your credit card burns.

[![npm version](https://img.shields.io/npm/v/@moven/sdk.svg?style=flat-square&color=ffde59)](https://www.npmjs.com/package/@moven/sdk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-success.svg?style=flat-square)](#)

---

## 💡 Why Moven AI?

Observability platforms (LangSmith, Langfuse, Helicone) record what happened **after** your agent finishes. If your agent enters an unhandled 150-step loop at 2 AM, traditional tools show you a $300 bill in the morning.

**Moven AI sits synchronously in the execution loop**. It evaluates deterministic heuristics in **< 1ms** on every tool call and trips the fuse mid-flight before money burns.

---

## ✨ Features

- ⚡ **Zero Latency Overhead**: In-memory deterministic heuristics evaluate in `< 1ms`.
- 🔁 **Canonical Deep Parameter Hashing**: SHA-256 canonical JSON serialization detects duplicate parameter loops regardless of object key order.
- 🤖 **LLM Judge Arbitrator**: Automatically detects zero-state progress deltas and switches to a cheaper model mid-flight.
- 🌐 **15+ Provider & Framework Adapters**: First-class support for OpenAI, Anthropic Claude, Google Gemini, Groq, Mistral, Cohere, Azure OpenAI, AWS Bedrock, Ollama, LangChain/LangGraph, Vercel AI SDK, LlamaIndex, CrewAI, AutoGen, and Custom Tools.
- 🛡️ **100% Standalone Offline Mode**: Zero required cloud dependencies. Runs entirely in-memory locally if no `MOVEN_API_KEY` is provided.

---

## 📦 Installation

```bash
npm install @moven/sdk
# or
pnpm add @moven/sdk
# or
yarn add @moven/sdk
```

---

## 🚀 Quick Start

### 1. Vercel AI SDK (`ai`)

```typescript
import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { wrapToolsWithMoven } from '@moven/sdk';
import { z } from 'zod';

const tools = wrapToolsWithMoven({
  searchDatabase: tool({
    description: 'Query database',
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }) => { /* ... */ },
  }),
}, {
  maxRepeatCalls: 3,         // Trip fuse after 3 identical tool calls
  maxCostDollar: 1.50,       // Trip fuse if cumulative run cost exceeds $1.50
  maxDepth: 12,              // Recursion limit
  agentName: 'customer-support-agent',
});

// Run agent safely
const result = await generateText({
  model: openai('gpt-4o'),
  tools,
  prompt: 'Help user resolve issue',
});
```

---

### 2. OpenAI SDK

```typescript
import { wrapOpenAIToolRunner } from '@moven/sdk';
import OpenAI from 'openai';

const openai = new OpenAI();
const wrappedTools = wrapOpenAIToolRunner({
  get_user_balance: async ({ userId }) => { /* ... */ }
}, {
  agentName: 'openai_finance_bot',
  currentModel: 'gpt-4o',
});
```

---

### 3. Anthropic Claude SDK

```typescript
import { wrapAnthropicToolUse } from '@moven/sdk';
import Anthropic from '@anthropic-ai/sdk';

const wrappedTools = wrapAnthropicToolUse({
  execute_query: async ({ query }) => { /* ... */ }
}, {
  agentName: 'claude_data_analyst',
  currentModel: 'claude-3-5-sonnet-20240620',
});
```

---

### 4. AWS Bedrock & Azure OpenAI

```typescript
import { wrapBedrockTools, wrapAzureOpenAITools } from '@moven/sdk';

const safeBedrockTools = wrapBedrockTools({
  fetch_s3_object: async ({ bucket, key }) => { /* ... */ }
}, { agentName: 'aws_bedrock_agent' });
```

---

## 🛠️ Supported Adapters Reference

| Provider / Framework | Wrapper Function Export |
| :--- | :--- |
| **Vercel AI SDK** | `wrapToolsWithMoven(tools, options)` |
| **OpenAI SDK** | `wrapOpenAIToolRunner(tools, options)` |
| **Anthropic Claude** | `wrapAnthropicToolUse(tools, options)` |
| **Google Gemini** | `wrapGoogleGeminiTools(tools, options)` |
| **Groq SDK** | `wrapGroqTools(tools, options)` |
| **Mistral AI** | `wrapMistralTools(tools, options)` |
| **Cohere SDK** | `wrapCohereTools(tools, options)` |
| **Azure OpenAI** | `wrapAzureOpenAITools(tools, options)` |
| **AWS Bedrock** | `wrapBedrockTools(tools, options)` |
| **Ollama (Local LLM)** | `wrapOllamaTools(tools, options)` |
| **LangChain / LangGraph** | `wrapLangChainTools(tools, options)` |
| **CrewAI / AutoGen** | `wrapCrewAITools(tools, options)`, `wrapAutoGenTools(tools, options)` |

---

## ⚙️ Configuration Options (`moven.config.ts`)

```typescript
import { createMovenCircuitBreaker } from '@moven/sdk';

export const movenCircuitBreaker = createMovenCircuitBreaker({
  agentId: 'agent_inventory_prod_01',
  agentName: 'inventory_production_agent',
  framework: 'LangGraph / LangChain',
  
  maxRepeatCalls: 5,               // Max identical tool calls in window (default: 5)
  repeatTimeWindowMs: 60000,       // Window duration in ms (default: 60000)
  maxCostDollar: 2.00,            // Max cost ceiling in USD (default: $2.00)
  maxDepth: 15,                    // Max total tool execution depth (default: 15)
  maxNoProgressTurns: 3,           // Max consecutive identical turn state hashes (default: 3)
  
  provider: 'openai',
  currentModel: 'gpt-4o',
  cheaperModel: 'gpt-4o-mini',
  autoFallbackCheaperModel: true,
  enableLlmJudgeArbitrator: true,

  onHallucination: ({ agentName, reason, toolName }) => {
    console.warn(`[Moven Alert] Agent '${agentName}' hallucination on tool '${toolName}': ${reason}`);
  },

  apiKey: process.env.MOVEN_API_KEY,
});
```

---

## 🤝 Contributing

We welcome contributions from the AI community! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for instructions on running unit tests and proposing new provider adapters.

---

## 📜 License

MIT © [Moven AI](https://moven.ai)
