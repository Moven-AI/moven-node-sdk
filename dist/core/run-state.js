"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MovenRunState = exports.DEFAULT_CHEAPER_MODEL_MAP = void 0;
const crypto_1 = __importDefault(require("crypto"));
exports.DEFAULT_CHEAPER_MODEL_MAP = {
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
class MovenRunState {
    runId;
    agentId;
    agentName;
    framework;
    version;
    tags;
    startTime;
    toolCalls = [];
    depth = 0;
    cumulativeCost = 0;
    stateHashes = [];
    isKilled = false;
    activeModel;
    isFallbackActive = false;
    cleanTurnsCount = 0;
    options;
    constructor(options = {}) {
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
    switchToCheaperModel() {
        const cheaper = this.getCheaperModel();
        this.activeModel = cheaper;
        this.isFallbackActive = true;
        this.cleanTurnsCount = 0;
        return cheaper;
    }
    registerCleanTurn() {
        if (!this.isFallbackActive)
            return false;
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
    updateOptions(newRules) {
        if (newRules.maxRepeatCalls !== undefined)
            this.options.maxRepeatCalls = newRules.maxRepeatCalls;
        if (newRules.maxCostDollar !== undefined)
            this.options.maxCostDollar = newRules.maxCostDollar;
        if (newRules.maxDepth !== undefined)
            this.options.maxDepth = newRules.maxDepth;
        if (newRules.maxNoProgressTurns !== undefined)
            this.options.maxNoProgressTurns = newRules.maxNoProgressTurns;
        if (newRules.cheaperModel !== undefined)
            this.options.cheaperModel = newRules.cheaperModel;
        if (newRules.autoFallbackCheaperModel !== undefined)
            this.options.autoFallbackCheaperModel = newRules.autoFallbackCheaperModel;
        if (newRules.enableLlmJudgeArbitrator !== undefined)
            this.options.enableLlmJudgeArbitrator = newRules.enableLlmJudgeArbitrator;
    }
    getCheaperModel(providerOrModel) {
        if (this.options.cheaperModel)
            return this.options.cheaperModel;
        const customMap = this.options.cheaperModelMap || {};
        const key = (providerOrModel || this.options.modelAuthor || this.options.provider || '').toLowerCase();
        // User-specified override takes priority
        if (customMap[key])
            return customMap[key];
        if (exports.DEFAULT_CHEAPER_MODEL_MAP[key])
            return exports.DEFAULT_CHEAPER_MODEL_MAP[key];
        // For OpenRouter routing: prefix the cheaper model with the author
        const routingLayer = (this.options.provider || '').toLowerCase();
        const author = (this.options.modelAuthor || '').toLowerCase();
        if (routingLayer === 'openrouter' && author) {
            const bareModel = exports.DEFAULT_CHEAPER_MODEL_MAP[author];
            if (bareModel)
                return `${author}/${bareModel}`;
        }
        if (this.options.judgeModel)
            return this.options.judgeModel;
        return 'google/gemini-2.5-flash-lite';
    }
    recordToolCall(toolName, args) {
        const argsHash = this.hashArguments(toolName, args);
        const log = {
            toolName,
            args,
            argsHash,
            timestamp: Date.now(),
        };
        this.toolCalls.push(log);
        this.depth += 1;
        return log;
    }
    recordToolResult(log, result, durationMs) {
        log.result = result;
        log.durationMs = durationMs || (Date.now() - log.timestamp);
        // Hash turn state for no-progress heuristic
        const turnHash = this.hashStateTurn(log.toolName, result);
        this.stateHashes.push(turnHash);
    }
    addCost(cost) {
        this.cumulativeCost += cost;
    }
    getMetrics() {
        return {
            totalCost: Number(this.cumulativeCost.toFixed(4)),
            totalToolCalls: this.toolCalls.length,
            repeatCallsCount: this.getRecentRepeatCallsCount(),
            depth: this.depth,
            durationMs: Date.now() - this.startTime,
        };
    }
    getRecentRepeatCallsCount(timeWindowMs) {
        const window = timeWindowMs || this.options.repeatTimeWindowMs || 60000;
        if (this.toolCalls.length === 0)
            return 0;
        const lastCall = this.toolCalls[this.toolCalls.length - 1];
        const now = Date.now();
        return this.toolCalls.filter(call => call.argsHash === lastCall.argsHash && (now - call.timestamp) <= window).length;
    }
    canonicalStringify(obj) {
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
    hashArguments(toolName, args) {
        try {
            const canonical = this.canonicalStringify({ toolName, args: args || {} });
            return crypto_1.default.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
        }
        catch {
            return `${toolName}_${Date.now()}`;
        }
    }
    hashStateTurn(toolName, result) {
        try {
            const canonical = this.canonicalStringify({ toolName, result });
            return crypto_1.default.createHash('sha256').update(canonical).digest('hex').substring(0, 16);
        }
        catch {
            return `turn_${Date.now()}`;
        }
    }
}
exports.MovenRunState = MovenRunState;
