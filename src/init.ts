import { MovenOptions, MovenRunState } from './core/run-state';
import { MovenReporter } from './reporter';
import { wrapCustomTool } from './adapters/custom';
import { MovenLogger } from './core/logger';

export interface MovenInitConfig extends MovenOptions {
  projectId?: string;
  apiKey?: string;
  endpoint?: string;
}

class MovenGlobalInstance {
  private config: MovenInitConfig = {};
  private initialized: boolean = false;
  private reporter?: MovenReporter;
  /**
   * Shared MovenRunState for every moven.guard() call made after init().
   * A shared state is what makes CROSS-TOOL detection possible: A→B→A→B
   * oscillation cycles and the per-run dollar budget only exist when all
   * guarded tools report into the same run state. Pass `sharedState: false`
   * to init() if you explicitly want per-tool isolation.
   */
  private sharedState?: MovenRunState;

  /**
   * Initializes Moven AI runtime safety and in-process circuit breaker.
   * Calling init() twice replaces the previous configuration and resets the
   * shared run state — almost always a bug (e.g. hot-reload double import),
   * so it is logged at error level.
   */
  public init(config: MovenInitConfig = {}): void {
    if (this.initialized) {
      MovenLogger.error(
        'moven.init() called twice — the previous configuration and shared run state were replaced. If this is server hot-reload, guard the call (e.g. `if (!moven.isInitialized())`).'
      );
    }
    this.config = {
      maxRepeatCalls: 3,
      maxCostDollar: 2.00,
      maxDepth: 15,
      enablePromptInjectionFirewall: true,
      autoFallbackCheaperModel: true,
      ...config,
    };
    this.reporter = new MovenReporter(this.config.apiKey, this.config.endpoint);
    this.sharedState = new MovenRunState(this.config);
    this.initialized = true;

    if (typeof process !== 'undefined' && process.env) {
      if (this.config.apiKey) process.env.MOVEN_API_KEY = this.config.apiKey;
      if (this.config.projectId) process.env.MOVEN_PROJECT_ID = this.config.projectId;
    }
  }

  public getConfig(): MovenInitConfig {
    return this.config;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public getSharedState(): MovenRunState | undefined {
    return this.sharedState;
  }

  public getReporter(): MovenReporter | undefined {
    return this.reporter;
  }

  /**
   * Protects any function or tool execution with the initialized global
   * Moven guardrails. All guarded tools share ONE run state (cross-tool
   * loop detection + a single per-run cost budget).
   */
  public guard<T extends (...args: any[]) => Promise<any>>(fn: T, customOpts?: MovenOptions): T {
    if (!this.initialized || !this.sharedState) {
      throw new Error('[Moven AI] Call moven.init({ apiKey, projectId }) before moven.guard(fn).');
    }
    const mergedOpts = { ...this.config, ...customOpts };
    const name = fn.name || 'custom_tool';
    return wrapCustomTool(name, fn, mergedOpts, this.sharedState);
  }
}

export const moven = new MovenGlobalInstance();
