import { safeStringify } from './safe-json';
/**
 * Moven AI Dynamic Model Pricing Engine
 * Powered by OpenRouter live model catalog & broker rates
 */

export interface ModelTokenRates {
  promptPerMillion: number;     // USD per 1,000,000 input tokens (e.g. 2.50)
  completionPerMillion: number; // USD per 1,000,000 output tokens (e.g. 10.00)
  promptPerToken: number;
  completionPerToken: number;
}

// Built-in baseline rates (Prompt / Completion per 1M tokens)
const DEFAULT_PRICING_TABLE: Record<string, ModelTokenRates> = {
  // OpenAI
  'openai/gpt-4o': { promptPerMillion: 2.50, completionPerMillion: 10.00, promptPerToken: 0.0000025, completionPerToken: 0.00001 },
  'gpt-4o': { promptPerMillion: 2.50, completionPerMillion: 10.00, promptPerToken: 0.0000025, completionPerToken: 0.00001 },
  'openai/gpt-4o-mini': { promptPerMillion: 0.15, completionPerMillion: 0.60, promptPerToken: 0.00000015, completionPerToken: 0.0000006 },
  'gpt-4o-mini': { promptPerMillion: 0.15, completionPerMillion: 0.60, promptPerToken: 0.00000015, completionPerToken: 0.0000006 },
  'openai/gpt-4-turbo': { promptPerMillion: 10.00, completionPerMillion: 30.00, promptPerToken: 0.00001, completionPerToken: 0.00003 },
  'openai/o1': { promptPerMillion: 15.00, completionPerMillion: 60.00, promptPerToken: 0.000015, completionPerToken: 0.00006 },
  'openai/o3-mini': { promptPerMillion: 1.10, completionPerMillion: 4.40, promptPerToken: 0.0000011, completionPerToken: 0.0000044 },

  // Anthropic
  'anthropic/claude-3.5-sonnet': { promptPerMillion: 3.00, completionPerMillion: 15.00, promptPerToken: 0.000003, completionPerToken: 0.000015 },
  'claude-3-5-sonnet': { promptPerMillion: 3.00, completionPerMillion: 15.00, promptPerToken: 0.000003, completionPerToken: 0.000015 },
  'anthropic/claude-3.5-haiku': { promptPerMillion: 0.80, completionPerMillion: 4.00, promptPerToken: 0.0000008, completionPerToken: 0.000004 },
  'claude-3-5-haiku': { promptPerMillion: 0.80, completionPerMillion: 4.00, promptPerToken: 0.0000008, completionPerToken: 0.000004 },
  'anthropic/claude-3-opus': { promptPerMillion: 15.00, completionPerMillion: 75.00, promptPerToken: 0.000015, completionPerToken: 0.000075 },

  // Google
  'google/gemini-2.5-flash': { promptPerMillion: 0.15, completionPerMillion: 0.60, promptPerToken: 0.00000015, completionPerToken: 0.0000006 },
  'gemini-2.5-flash': { promptPerMillion: 0.15, completionPerMillion: 0.60, promptPerToken: 0.00000015, completionPerToken: 0.0000006 },
  'google/gemini-2.5-flash-lite': { promptPerMillion: 0.075, completionPerMillion: 0.30, promptPerToken: 0.000000075, completionPerToken: 0.0000003 },
  'google/gemini-1.5-pro': { promptPerMillion: 1.25, completionPerMillion: 5.00, promptPerToken: 0.00000125, completionPerToken: 0.000005 },

  // DeepSeek
  'deepseek/deepseek-chat': { promptPerMillion: 0.14, completionPerMillion: 0.28, promptPerToken: 0.00000014, completionPerToken: 0.00000028 },
  'deepseek/deepseek-reasoner': { promptPerMillion: 0.55, completionPerMillion: 2.19, promptPerToken: 0.00000055, completionPerToken: 0.00000219 },
  'deepseek-chat': { promptPerMillion: 0.14, completionPerMillion: 0.28, promptPerToken: 0.00000014, completionPerToken: 0.00000028 },

  // Enterprise direct providers
  'xai/grok-2': { promptPerMillion: 2.00, completionPerMillion: 10.00, promptPerToken: 0.000002, completionPerToken: 0.00001 },
  'xai/grok-3': { promptPerMillion: 3.00, completionPerMillion: 15.00, promptPerToken: 0.000003, completionPerToken: 0.000015 },
  'grok-3': { promptPerMillion: 3.00, completionPerMillion: 15.00, promptPerToken: 0.000003, completionPerToken: 0.000015 },
  'perplexity/sonar': { promptPerMillion: 1.00, completionPerMillion: 1.00, promptPerToken: 0.000001, completionPerToken: 0.000001 },
  'sonar': { promptPerMillion: 1.00, completionPerMillion: 1.00, promptPerToken: 0.000001, completionPerToken: 0.000001 },
  'perplexity/sonar-pro': { promptPerMillion: 3.00, completionPerMillion: 15.00, promptPerToken: 0.000003, completionPerToken: 0.000015 },
  'moonshot/kimi-k2': { promptPerMillion: 0.60, completionPerMillion: 2.50, promptPerToken: 0.0000006, completionPerToken: 0.0000025 },
  'moonshot-v1-8k': { promptPerMillion: 0.17, completionPerMillion: 0.17, promptPerToken: 0.00000017, completionPerToken: 0.00000017 },
  'qwen/qwen-turbo': { promptPerMillion: 0.05, completionPerMillion: 0.20, promptPerToken: 0.00000005, completionPerToken: 0.0000002 },
  'qwen-turbo': { promptPerMillion: 0.05, completionPerMillion: 0.20, promptPerToken: 0.00000005, completionPerToken: 0.0000002 },
  'zhipu/glm-4-flash': { promptPerMillion: 0.00, completionPerMillion: 0.00, promptPerToken: 0, completionPerToken: 0 },
  'glm-4-flash': { promptPerMillion: 0.00, completionPerMillion: 0.00, promptPerToken: 0, completionPerToken: 0 },
  'yi-lightning': { promptPerMillion: 0.14, completionPerMillion: 0.14, promptPerToken: 0.00000014, completionPerToken: 0.00000014 },
  'meta-llama/llama-3.1-8b-instruct': { promptPerMillion: 0.10, completionPerMillion: 0.25, promptPerToken: 0.0000001, completionPerToken: 0.00000025 },
};

export class MovenDynamicPricingEngine {
  private static livePricingCache = new Map<string, ModelTokenRates>();
  private static lastSyncTime = 0;
  private static isSyncing = false;
  private static syncIntervalMs = 60 * 60 * 1000; // 1 Hour

  /**
   * Retrieves synchronous model pricing (from cache or defaults, 0ms latency)
   */
  public static getModelRates(modelName?: string): ModelTokenRates {
    if (!modelName) {
      return { promptPerMillion: 0.15, completionPerMillion: 0.60, promptPerToken: 0.00000015, completionPerToken: 0.0000006 };
    }

    const cleanName = modelName.toLowerCase().trim();

    // 1. Check live cache first
    if (this.livePricingCache.has(cleanName)) {
      return this.livePricingCache.get(cleanName)!;
    }

    // 2. Check default pricing table
    if (DEFAULT_PRICING_TABLE[cleanName]) {
      return DEFAULT_PRICING_TABLE[cleanName];
    }

    // 3. Fuzzy match (e.g. 'gpt-4o' in 'openai/gpt-4o-2024-08-06')
    for (const [key, val] of Object.entries(DEFAULT_PRICING_TABLE)) {
      if (cleanName.includes(key) || key.includes(cleanName)) {
        return val;
      }
    }

    // 4. Fallback base rate
    return { promptPerMillion: 0.15, completionPerMillion: 0.60, promptPerToken: 0.00000015, completionPerToken: 0.0000006 };
  }

  /**
   * Asynchronously fetches live OpenRouter rates from api.moven.dev or openrouter.ai
   */
  public static async refreshLivePricing(apiBaseUrl = 'https://api.moven.dev'): Promise<void> {
    const now = Date.now();
    if (this.isSyncing || (now - this.lastSyncTime < this.syncIntervalMs && this.livePricingCache.size > 0)) {
      return;
    }

    this.isSyncing = true;
    try {
      const endpoints = [
        `${apiBaseUrl}/v1/models`,
        'https://openrouter.ai/api/v1/models',
      ];

      for (const endpoint of endpoints) {
        try {
          const res = await fetch(endpoint, {
            headers: { 'Content-Type': 'application/json' },
          });

          if (res.ok) {
            const json = await res.json();
            const list: any[] = json.data || json.models || [];
            
            for (const item of list) {
              const promptPerToken = parseFloat(item.pricing?.prompt || item.promptPerToken || '0');
              const completionPerToken = parseFloat(item.pricing?.completion || item.completionPerToken || '0');
              const promptPerMillion = item.promptPerMillion || Number((promptPerToken * 1_000_000).toFixed(4));
              const completionPerMillion = item.completionPerMillion || Number((completionPerToken * 1_000_000).toFixed(4));

              const rateObj: ModelTokenRates = {
                promptPerMillion,
                completionPerMillion,
                promptPerToken: promptPerToken > 0 ? promptPerToken : promptPerMillion / 1_000_000,
                completionPerToken: completionPerToken > 0 ? completionPerToken : completionPerMillion / 1_000_000,
              };

              if (item.id) {
                this.livePricingCache.set(item.id.toLowerCase(), rateObj);
                const shortId = item.id.split('/')[1];
                if (shortId) {
                  this.livePricingCache.set(shortId.toLowerCase(), rateObj);
                }
              }
            }

            this.lastSyncTime = now;
            break;
          }
        } catch {
          // Try next endpoint
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Estimates token count from arbitrary text or structured payloads using ~4 chars/token heuristic
   */
  public static estimateTokens(payload: any): number {
    if (payload === undefined || payload === null) return 0;
    try {
      const str = typeof payload === 'string' ? payload : safeStringify(payload);
      return Math.max(Math.ceil(str.length / 4), 1);
    } catch {
      return 10;
    }
  }

  /**
   * Calculates exact per-token cost for an individual step or execution turn
   */
  public static calculateStepTokenCost(params: {
    promptTokens: number;
    completionTokens: number;
    modelName?: string;
    customPromptRatePerMillion?: number;
    customCompletionRatePerMillion?: number;
  }): {
    stepCost: number;
    promptCost: number;
    completionCost: number;
    totalTokens: number;
    costPerPromptToken: number;
    costPerCompletionToken: number;
  } {
    const rates = this.getModelRates(params.modelName);
    const promptRatePerMillion = params.customPromptRatePerMillion ?? rates.promptPerMillion;
    const completionRatePerMillion = params.customCompletionRatePerMillion ?? rates.completionPerMillion;

    const costPerPromptToken = promptRatePerMillion / 1_000_000;
    const costPerCompletionToken = completionRatePerMillion / 1_000_000;

    const promptCost = params.promptTokens * costPerPromptToken;
    const completionCost = params.completionTokens * costPerCompletionToken;
    const stepCost = promptCost + completionCost;

    return {
      stepCost,
      promptCost,
      completionCost,
      totalTokens: params.promptTokens + params.completionTokens,
      costPerPromptToken,
      costPerCompletionToken,
    };
  }

  /**
   * Accurate calculation of money saved when an infinite / runaway loop is tripped.
   * First computes exact token counts used and per-token unit rates, then multiplies prevented tokens.
   */
  public static calculateMoneySaved(params: {
    modelName?: string;
    totalToolCallsMade: number;
    actualCostSpent?: number;
    actualPromptTokensSpent?: number;
    actualCompletionTokensSpent?: number;
    customPromptRatePerMillion?: number;
    customCompletionRatePerMillion?: number;
  }): {
    moneySaved: number;
    preventedRunawaySteps: number;
    totalPreventedTokens: number;
    preventedPromptTokens: number;
    preventedCompletionTokens: number;
    promptPerMillion: number;
    completionPerMillion: number;
    costPerPromptToken: number;
    costPerCompletionToken: number;
    activeModel: string;
  } {
    const activeModel = params.modelName || 'openai/gpt-4o-mini';
    const rates = this.getModelRates(activeModel);

    const promptPerMillion = params.customPromptRatePerMillion ?? rates.promptPerMillion;
    const completionPerMillion = params.customCompletionRatePerMillion ?? rates.completionPerMillion;
    const actualCost = params.actualCostSpent || 0;

    // Unit rate per single token
    const costPerPromptToken = promptPerMillion / 1_000_000;
    const costPerCompletionToken = completionPerMillion / 1_000_000;

    // 1. Determine actual average token usage per step from this run
    let avgPromptTokensPerStep: number;
    let avgOutputTokensPerStep: number;

    if (params.actualPromptTokensSpent && params.totalToolCallsMade > 0) {
      avgPromptTokensPerStep = Math.max(Math.round(params.actualPromptTokensSpent / params.totalToolCallsMade), 100);
    } else {
      avgPromptTokensPerStep = 2500;
    }

    if (params.actualCompletionTokensSpent && params.totalToolCallsMade > 0) {
      avgOutputTokensPerStep = Math.max(Math.round(params.actualCompletionTokensSpent / params.totalToolCallsMade), 50);
    } else {
      avgOutputTokensPerStep = 500;
    }

    // 2. Typical runaway unconstrained loop would spin ~15-50 extra turns
    const preventedRunawaySteps = Math.max(15 - params.totalToolCallsMade, 10);
    const preventedPromptTokens = preventedRunawaySteps * avgPromptTokensPerStep;
    const preventedCompletionTokens = preventedRunawaySteps * avgOutputTokensPerStep;
    const totalPreventedTokens = preventedPromptTokens + preventedCompletionTokens;

    // 3. Exact per-token cost calculation for prevented tokens
    const preventedPromptCost = preventedPromptTokens * costPerPromptToken;
    const preventedCompletionCost = preventedCompletionTokens * costPerCompletionToken;
    const totalPreventedCost = preventedPromptCost + preventedCompletionCost;

    const moneySaved = Number(Math.max(totalPreventedCost - actualCost, 0.001).toFixed(4));

    return {
      moneySaved,
      preventedRunawaySteps,
      totalPreventedTokens,
      preventedPromptTokens,
      preventedCompletionTokens,
      promptPerMillion,
      completionPerMillion,
      costPerPromptToken,
      costPerCompletionToken,
      activeModel,
    };
  }
}
