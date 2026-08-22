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
   * Transparent calculation of money saved when an infinite / runaway loop is tripped
   */
  public static calculateMoneySaved(params: {
    modelName?: string;
    totalToolCallsMade: number;
    actualCostSpent?: number;
    customPromptRatePerMillion?: number;
    customCompletionRatePerMillion?: number;
  }): {
    moneySaved: number;
    preventedRunawaySteps: number;
    totalPreventedTokens: number;
    promptPerMillion: number;
    completionPerMillion: number;
    activeModel: string;
  } {
    const activeModel = params.modelName || 'openai/gpt-4o-mini';
    const rates = this.getModelRates(activeModel);

    const promptPerMillion = params.customPromptRatePerMillion || rates.promptPerMillion;
    const completionPerMillion = params.customCompletionRatePerMillion || rates.completionPerMillion;
    const actualCost = params.actualCostSpent || 0.001;

    // Realistic token breakdown per agent step: 3,500 input tokens + 500 output tokens
    const avgInputTokensPerStep = 3500;
    const avgOutputTokensPerStep = 500;
    const preventedRunawaySteps = Math.max(15 - params.totalToolCallsMade, 5);
    const totalPreventedTokens = preventedRunawaySteps * (avgInputTokensPerStep + avgOutputTokensPerStep);

    const preventedInputCost = (preventedRunawaySteps * avgInputTokensPerStep / 1_000_000) * promptPerMillion;
    const preventedOutputCost = (preventedRunawaySteps * avgOutputTokensPerStep / 1_000_000) * completionPerMillion;
    const totalPreventedCost = preventedInputCost + preventedOutputCost;

    const moneySaved = Math.max(totalPreventedCost - actualCost, 0.001);

    return {
      moneySaved,
      preventedRunawaySteps,
      totalPreventedTokens,
      promptPerMillion,
      completionPerMillion,
      activeModel,
    };
  }
}
