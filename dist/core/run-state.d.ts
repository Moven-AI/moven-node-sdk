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
    agentId?: string;
    agentName?: string;
    framework?: string;
    version?: string;
    tags?: string[];
    maxRepeatCalls?: number;
    repeatTimeWindowMs?: number;
    maxCostDollar?: number;
    maxDepth?: number;
    maxNoProgressTurns?: number;
    judgeModel?: string;
    provider?: 'openai' | 'anthropic' | 'google' | 'cohere' | 'mistral' | 'groq' | 'openrouter' | string;
    modelAuthor?: string;
    currentModel?: string;
    cheaperModel?: string;
    cheaperModelMap?: Record<string, string>;
    autoFallbackCheaperModel?: boolean;
    enableLlmJudgeArbitrator?: boolean;
    promptCostPerMillion?: number;
    completionCostPerMillion?: number;
    apiKey?: string;
    endpoint?: string;
    onKill?: (error: any) => void;
    onHallucination?: (info: {
        agentName: string;
        reason: string;
        toolName?: string;
        args?: any;
    }) => void;
    customCheck?: (state: MovenRunState) => {
        tripped: boolean;
        reason: string;
    } | null;
}
export declare const DEFAULT_CHEAPER_MODEL_MAP: Record<string, string>;
export declare class MovenRunState {
    readonly runId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly framework: string;
    readonly version: string;
    readonly tags: string[];
    readonly startTime: number;
    toolCalls: ToolCallLog[];
    depth: number;
    cumulativeCost: number;
    stateHashes: string[];
    isKilled: boolean;
    activeModel: string;
    isFallbackActive: boolean;
    cleanTurnsCount: number;
    options: MovenOptions;
    constructor(options?: MovenOptions);
    switchToCheaperModel(): string;
    registerCleanTurn(): boolean;
    updateOptions(newRules: Partial<MovenOptions>): void;
    getCheaperModel(providerOrModel?: string): string;
    recordToolCall(toolName: string, args: any): ToolCallLog;
    recordToolResult(log: ToolCallLog, result: any, durationMs?: number): void;
    addCost(cost: number): void;
    getMetrics(): MovenKillMetrics;
    getRecentRepeatCallsCount(timeWindowMs?: number): number;
    private canonicalStringify;
    private hashArguments;
    private hashStateTurn;
}
