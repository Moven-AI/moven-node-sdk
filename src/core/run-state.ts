import crypto from 'crypto';
import { MovenKillMetrics } from './errors';

export interface ToolCallLog {
  toolName: string;
  args: any;
  argsHash: string;
  timestamp: number;
  result?: any;
  durationMs?: number;
}

export interface MovenOptions {
  runId?: string;
  agentId?: string; // Unique agent identifier (e.g. 'agent_inventory_prod_01')
  agentName?: string; // Production agent name identifier
  framework?: string; // Agent framework (e.g. 'LangGraph / LangChain', 'Vercel AI SDK')
  version?: string; // Agent version identifier
  tags?: string[]; // Environment or category tags
  maxRepeatCalls?: number; // default: 5
  repeatTimeWindowMs?: number; // default: 60000 (60s)
  maxCostDollar?: number; // default: 2.00
  maxDepth?: number; // default: 15
  maxNoProgressTurns?: number; // default: 3
  judgeModel?: string; // default: 'google/gemini-2.5-flash-lite'
  provider?: 'openai' | 'anthropic' | 'google' | 'cohere' | 'mistral' | 'groq' | 'openrouter' | string;
  modelAuthor?: string; // The model family author (e.g. 'openai' from 'openai/gpt-4o-mini')
  currentModel?: string; // The exact model ID the user's code is running
  cheaperModel?: string; // Explicit cheaper fallback model ID (e.g. 'google/gemini-2.5-flash-lite')
  cheaperModelMap?: Record<string, string>; // Mapping of provider/primary model -> cheaper model
  autoFallbackCheaperModel?: boolean; // default: true
  enableLlmJudgeArbitrator?: boolean; // default: true
  promptCostPerMillion?: number;
  completionCostPerMillion?: number;
  apiKey?: string;
  endpoint?: string; // default: https://moven.ai/api/events or local endpoint
  onKill?: (error: any) => void;
  onHallucination?: (info: { agentName: string; reason: string; toolName?: string; args?: any }) => void;
  customCheck?: (state: MovenRunState) => { tripped: boolean; reason: string } | null;
}

export const DEFAULT_CHEAPER_MODEL_MAP: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-haiku-20240307',
  google: 'gemini-2.5-flash-lite',
  groq: 'llama-3.1-8b-instant',
  mistral: 'mistral-small-latest',
  cohere: 'command-r',
  openrouter: 'openai/gpt-4o-mini',
  'meta-llama': 'meta-llama/llama-3.1-8b-instruct',
  mistralai: 'mistralai/mistral-small-24b-instruct-2501',
  // Model specific overrides
  'gpt-4o': 'gpt-4o-mini',
  'gpt-4-turbo': 'gpt-4o-mini',
  'gpt-4': 'gpt-4o-mini',
  'claude-3-5-sonnet-20240620': 'claude-3-haiku-20240307',
  'claude-3-opus-20240229': 'claude-3-haiku-20240307',
  'gemini-1.5-pro': 'gemini-2.5-flash-lite',
  'gemini-2.0-flash': 'gemini-2.5-flash-lite',
};

export class MovenRunState {
  public readonly runId: string;
  public readonly agentId: string;
  public readonly agentName: string;
  public readonly framework: string;
  public readonly version: string;
  public readonly tags: string[];
  public readonly startTime: number;
  public toolCalls: ToolCallLog[] = [];
  public depth: number = 0;
  public cumulativeCost: number = 0;
  public stateHashes: string[] = [];
  public isKilled: boolean = false;
  public activeModel: string;
  public isFallbackActive: boolean = false;
  public cleanTurnsCount: number = 0;
  public options: MovenOptions;

  constructor(options: MovenOptions = {}) {
    this.options = {
      maxRepeatCalls: 5,
      repeatTimeWindowMs: 60000,
      maxCostDollar: 2.00,
      maxDepth: 15,
      maxNoProgressTurns: 3,
      judgeModel: options.judgeModel || 'google/gemini-2.5-flash-lite',
      autoFallbackCheaperModel: options.autoFallbackCheaperModel ?? true,
      enableLlmJudgeArbitrator: options.enableLlmJudgeArbitrator ?? true,
      agentName: 'agent-run',
      ...options,
    };
    this.runId = options.runId || `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    this.agentName = this.options.agentName || 'default-agent';
    this.agentId = this.options.agentId || `agent_${this.agentName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    this.framework = this.options.framework || 'Custom Agent Wrapper';
    this.version = this.options.version || '1.0.0';
    this.tags = this.options.tags || ['production'];
    this.startTime = Date.now();
    this.activeModel = this.options.currentModel || 'openai/gpt-4o-mini';
  }

  public switchToCheaperModel(): string {
    const cheaper = this.getCheaperModel();
    this.activeModel = cheaper;
    this.isFallbackActive = true;
    this.cleanTurnsCount = 0;
    return cheaper;
  }

  public registerCleanTurn(): boolean {
    if (!this.isFallbackActive) return false;
    this.cleanTurnsCount += 1;
    // If agent makes 3 consecutive clean turns under fallback, restore primary model!
    if (this.cleanTurnsCount >= 3) {
      this.activeModel = this.options.currentModel || 'openai/gpt-4o-mini';
      this.isFallbackActive = false;
      this.cleanTurnsCount = 0;
      return true; // Model restored!
    }
    return false;
  }

  public updateOptions(newRules: Partial<MovenOptions>) {
    if (newRules.maxRepeatCalls !== undefined) this.options.maxRepeatCalls = newRules.maxRepeatCalls;
    if (newRules.maxCostDollar !== undefined) this.options.maxCostDollar = newRules.maxCostDollar;
    if (newRules.maxDepth !== undefined) this.options.maxDepth = newRules.maxDepth;
    if (newRules.maxNoProgressTurns !== undefined) this.options.maxNoProgressTurns = newRules.maxNoProgressTurns;
    if (newRules.cheaperModel !== undefined) this.options.cheaperModel = newRules.cheaperModel;
    if (newRules.autoFallbackCheaperModel !== undefined) this.options.autoFallbackCheaperModel = newRules.autoFallbackCheaperModel;
    if (newRules.enableLlmJudgeArbitrator !== undefined) this.options.enableLlmJudgeArbitrator = newRules.enableLlmJudgeArbitrator;
  }

  public getCheaperModel(providerOrModel?: string): string {
    if (this.options.cheaperModel) return this.options.cheaperModel;
    const customMap = this.options.cheaperModelMap || {};
    const key = (providerOrModel || this.options.modelAuthor || this.options.provider || '').toLowerCase();
    
    // User-specified override takes priority
    if (customMap[key]) return customMap[key];
    if (DEFAULT_CHEAPER_MODEL_MAP[key]) return DEFAULT_CHEAPER_MODEL_MAP[key];
    
    // For OpenRouter routing: prefix the cheaper model with the author
    const routingLayer = (this.options.provider || '').toLowerCase();
    const author = (this.options.modelAuthor || '').toLowerCase();
    if (routingLayer === 'openrouter' && author) {
      const bareModel = DEFAULT_CHEAPER_MODEL_MAP[author];
      if (bareModel) return `${author}/${bareModel}`;
    }
    
    if (this.options.judgeModel) return this.options.judgeModel;
    return 'google/gemini-2.5-flash-lite';
  }

  public recordToolCall(toolName: string, args: any): ToolCallLog {
    const argsHash = this.hashArguments(toolName, args);
    const log: ToolCallLog = {
      toolName,
      args,
      argsHash,
      timestamp: Date.now(),
    };
    this.toolCalls.push(log);
    this.depth += 1;
    return log;
  }

  public recordToolResult(log: ToolCallLog, result: any, durationMs?: number) {
    log.result = result;
    log.durationMs = durationMs || (Date.now() - log.timestamp);
    
    // Hash turn state for no-progress heuristic
    const turnHash = this.hashStateTurn(log.toolName, result);
    this.stateHashes.push(turnHash);
  }

  public addCost(cost: number) {
    this.cumulativeCost += cost;
  }

  public getMetrics(): MovenKillMetrics {
    return {
      totalCost: Number(this.cumulativeCost.toFixed(4)),
      totalToolCalls: this.toolCalls.length,
      repeatCallsCount: this.getRecentRepeatCallsCount(),
      depth: this.depth,
      durationMs: Date.now() - this.startTime,
    };
  }

  public getRecentRepeatCallsCount(timeWindowMs?: number): number {
    const window = timeWindowMs || this.options.repeatTimeWindowMs || 60000;
    if (this.toolCalls.length === 0) return 0;
    
    const lastCall = this.toolCalls[this.toolCalls.length - 1];
    const now = Date.now();

    return this.toolCalls.filter(call => 
      call.argsHash === lastCall.argsHash && (now - call.timestamp) <= window
    ).length;
  }

  private canonicalStringify(obj: any): string {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return '[' + obj.map(item => this.canonicalStringify(item)).join(',') + ']';
    }
    const keys = Object.keys(obj).sort();
    const keyPairs = keys.map(key => `${JSON.stringify(key)}:${this.canonicalStringify(obj[key])}`);
    return '{' + keyPairs.join(',') + '}';
  }

  private hashArguments(toolName: string, args: any): string {
    try {
      const canonical = this.canonicalStringify({ toolName, args: args || {} });
      return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
    } catch {
      return `${toolName}_${Date.now()}`;
    }
  }

  private hashStateTurn(toolName: string, result: any): string {
    try {
      const canonical = this.canonicalStringify({ toolName, result });
      return crypto.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
    } catch {
      return `turn_${Date.now()}`;
    }
  }
}
