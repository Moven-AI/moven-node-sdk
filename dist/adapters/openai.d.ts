import { MovenRunState, MovenOptions } from '../core/run-state';
export declare function wrapOpenAIToolRunner<T extends (...args: any[]) => Promise<any>>(toolName: string, fn: T, options?: MovenOptions, sharedState?: MovenRunState): T;
