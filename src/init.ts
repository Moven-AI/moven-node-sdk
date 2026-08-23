import { MovenOptions, MovenRunState } from './core/run-state';
import { MovenHeuristicsEngine } from './core/heuristics';
import { MovenPromptInjectionFirewall } from './core/prompt-firewall';
import { MovenKillError } from './core/errors';
import { MovenReporter } from './reporter';
import { movenGuard } from './adapters/custom';

export interface MovenInitConfig extends MovenOptions {
  projectId?: string;
  apiKey?: string;
  endpoint?: string;
  autoInstrument?: boolean;
}

class MovenGlobalInstance {
  private config: MovenInitConfig = {};
  private initialized: boolean = false;
  private reporter?: MovenReporter;

  /**
   * Initializes Moven AI runtime safety and in-process circuit breaker.
   * Auto-instruments global execution context with sub-0.3ms safety fuses.
   */
  public init(config: MovenInitConfig = {}): void {
    this.config = {
      maxRepeatCalls: 3,
      maxCostDollar: 2.00,
      maxDepth: 15,
      enablePromptInjectionFirewall: true,
      autoFallbackCheaperModel: true,
      ...config,
    };
    this.reporter = new MovenReporter(this.config.apiKey, this.config.endpoint);
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

  /**
   * Protects any function or tool execution with initialized global Moven guardrails.
   */
  public guard<T extends (...args: any[]) => Promise<any>>(fn: T, customOpts?: MovenOptions): T {
    return movenGuard(fn, { ...this.config, ...customOpts });
  }
}

export const moven = new MovenGlobalInstance();
