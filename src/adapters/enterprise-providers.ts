import { MovenRunState, MovenOptions } from '../core/run-state';
import { MovenHeuristicsEngine } from '../core/heuristics';
import { MovenKillHandler } from '../kill/abort';
import { MovenReporter } from '../reporter';

/**
 * Enterprise provider adapters — thin, first-class wrappers for direct
 * (non-OpenRouter) LLM providers. All share the same in-process interception
 * pipeline: record → pre-check → execute → post-check → trip on violation.
 *
 * Any provider not listed here works out of the box with `wrapCustomTool` /
 * `movenGuard` / `wrapProviderTools` — the breaker is provider-agnostic.
 */

interface AdapterConfig {
  provider: string;
  framework: string;
  /** Estimated per-step dispatch cost added to the burn ledger */
  stepCost: number;
}

/**
 * Generic provider tool wrapper. Use this for any provider:
 *   const tools = wrapProviderTools('xai', 'xAI SDK', 0.01, myTools)
 */
export function wrapProviderTools<T extends Record<string, any>>(
  provider: string,
  framework: string,
  stepCost: number,
  tools: T,
  options?: MovenOptions
): T {
  const optsWithProvider = { provider, framework, ...options };
  const state = new MovenRunState(optsWithProvider);
  const reporter = new MovenReporter(options?.apiKey, options?.endpoint);

  reporter.reportRunStart(state);

  const wrappedObj = {} as any;

  for (const [toolName, toolDef] of Object.entries(tools)) {
    if (!toolDef) continue;
    const fn = typeof toolDef === 'function' ? toolDef : (toolDef.execute || toolDef.func || toolDef.run);
    if (typeof fn !== 'function') {
      wrappedObj[toolName] = toolDef;
      continue;
    }

    const wrappedFn = async (...args: any[]) => {
      const log = state.recordToolCall(toolName, args[0] || args);
      state.addCost(stepCost);

      const check = MovenHeuristicsEngine.evaluate(state);
      await MovenKillHandler.handleTripResult(check, state, reporter);

      const start = Date.now();
      try {
        const res = await fn(...args);
        state.recordToolResult(log, res, Date.now() - start);

        const postCheck = MovenHeuristicsEngine.evaluate(state);
        await MovenKillHandler.handleTripResult(postCheck, state, reporter);

        return res;
      } catch (err: any) {
        if (err?.name === 'MovenKillError') throw err;
        state.recordToolResult(log, { error: err?.message || String(err) }, Date.now() - start);
        throw err;
      }
    };

    if (typeof toolDef === 'function') {
      wrappedObj[toolName] = wrappedFn;
    } else {
      wrappedObj[toolName] = {
        ...toolDef,
        execute: wrappedFn,
      };
    }
  }

  return wrappedObj as T;
}

function makeAdapter(config: AdapterConfig) {
  return function wrap<T extends Record<string, any>>(tools: T, options?: MovenOptions): T {
    return wrapProviderTools(config.provider, config.framework, config.stepCost, tools, options);
  };
}

// ── First-class adapters for 13 direct providers ────────────────────────────

/** xAI Grok (grok-2, grok-3, grok-4) */
export const wrapXAITools = makeAdapter({ provider: 'xai', framework: 'xAI SDK', stepCost: 0.008 });

/** Perplexity (sonar, sonar-pro — online LLMs with citations) */
export const wrapPerplexityTools = makeAdapter({ provider: 'perplexity', framework: 'Perplexity API', stepCost: 0.006 });

/** DeepSeek direct API (deepseek-chat, deepseek-reasoner) */
export const wrapDeepSeekTools = makeAdapter({ provider: 'deepseek', framework: 'DeepSeek API', stepCost: 0.002 });

/** Together AI (open-source model cloud) */
export const wrapTogetherTools = makeAdapter({ provider: 'together', framework: 'Together SDK', stepCost: 0.003 });

/** Fireworks AI (fast open-source inference) */
export const wrapFireworksTools = makeAdapter({ provider: 'fireworks', framework: 'Fireworks SDK', stepCost: 0.003 });

/** DeepInfra (open-source model cloud) */
export const wrapDeepInfraTools = makeAdapter({ provider: 'deepinfra', framework: 'DeepInfra API', stepCost: 0.002 });

/** Cerebras (wafer-scale fast inference) */
export const wrapCerebrasTools = makeAdapter({ provider: 'cerebras', framework: 'Cerebras SDK', stepCost: 0.002 });

/** SambaNova Cloud */
export const wrapSambaNovaTools = makeAdapter({ provider: 'sambanova', framework: 'SambaNova API', stepCost: 0.003 });

/** NVIDIA NIM (build.nvidia.com microservices) */
export const wrapNvidiaNimTools = makeAdapter({ provider: 'nvidia', framework: 'NVIDIA NIM', stepCost: 0.004 });

/** Moonshot AI (Kimi) */
export const wrapMoonshotTools = makeAdapter({ provider: 'moonshot', framework: 'Moonshot SDK', stepCost: 0.003 });

/** Alibaba Qwen via DashScope compatible mode */
export const wrapQwenTools = makeAdapter({ provider: 'qwen', framework: 'DashScope (Qwen)', stepCost: 0.003 });

/** Zhipu GLM (bigmodel.cn) */
export const wrapZhipuTools = makeAdapter({ provider: 'zhipu', framework: 'Zhipu GLM', stepCost: 0.003 });

/** Yi / 01.AI (lingyiwanwu) */
export const wrapYiTools = makeAdapter({ provider: 'yi', framework: 'Yi API', stepCost: 0.003 });

/** Hugging Face Inference Router */
export const wrapHuggingFaceTools = makeAdapter({ provider: 'huggingface', framework: 'HF Inference Router', stepCost: 0.002 });
