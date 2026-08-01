import { MovenRunState, MovenOptions } from '../core/run-state';
export declare function wrapAnthropicToolUse<T extends (...args: any[]) => Promise<any>>(toolName: string, handler: T, options?: MovenOptions, sharedState?: MovenRunState): T;
