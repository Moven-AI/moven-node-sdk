import { MovenRunState } from './run-state';

export interface BurnGuardOptions {
  maxHourlySpendDollar?: number;       // default: $10.00/hour (rolling 60-minute window, per run)
  maxRunDurationMinutes?: number;      // default: 60 minutes max wall-clock duration
  maxOvernightTotalDollar?: number;    // default: $25.00 hard cap overnight
  /** Local hour the overnight quiet window starts (inclusive). Default: 0 (12 AM) */
  overnightWindowStartHour?: number;
  /** Local hour the overnight quiet window ends (exclusive). Default: 8 (8 AM) */
  overnightWindowEndHour?: number;
  stagnationTimeoutSeconds?: number;   // default: 300 seconds (5 min) without step activity
  emergencySlackWebhook?: string;
  emergencySmsPhone?: string;
  isEnabled?: boolean;                 // default: true
}

export interface BurnGuardCheckResult {
  tripped: boolean;
  reason?: string;
  guardType?: 'hourly_velocity_exceeded' | 'max_duration_exceeded' | 'overnight_cap_exceeded' | 'stagnation_timeout';
}

export class MovenOvernightBurnGuard {
  /**
   * Records a spend event into the run's rolling 60-minute velocity window.
   * Scoped to the given MovenRunState — spend from other runs in the same
   * process never contaminates this run's velocity math (and never
   * double-counts, because evaluate() sums ONLY this window).
   * Wired automatically by MovenRunState.addCost / recordStepTokens /
   * recordToolCall — call directly only for custom spend accounting.
   */
  public static recordSpend(state: MovenRunState, cost: number) {
    if (cost > 0) {
      state.hourlySpendWindow.push({ timestamp: Date.now(), cost });
      // Bounded window: one entry per spend event; prune lazily on evaluate.
      if (state.hourlySpendWindow.length > 10000) {
        this.pruneWindow(state);
      }
    }
  }

  private static pruneWindow(state: MovenRunState) {
    const windowStart = Date.now() - 60 * 60 * 1000;
    state.hourlySpendWindow = state.hourlySpendWindow.filter(w => w.timestamp >= windowStart);
  }

  public static evaluate(state: MovenRunState): BurnGuardCheckResult {
    const opts: BurnGuardOptions = state.options.burnGuard || {};
    if (opts.isEnabled === false) return { tripped: false };

    const maxHourly = opts.maxHourlySpendDollar ?? 10.00;
    const maxDuration = opts.maxRunDurationMinutes ?? 60;
    const maxOvernight = opts.maxOvernightTotalDollar ?? 25.00;
    const stagnationSec = opts.stagnationTimeoutSeconds ?? 300;

    const now = Date.now();

    // 1. Wall-Clock Max Duration Check
    const runDurationMins = (now - state.startTime) / (1000 * 60);
    if (runDurationMins >= maxDuration) {
      return {
        tripped: true,
        guardType: 'max_duration_exceeded',
        reason: `[Overnight Burn Guard] Run duration (${runDurationMins.toFixed(1)}m) exceeded max lifetime cap (${maxDuration}m). Auto-killed to prevent runaway background tasks.`,
      };
    }

    // 2. Idle Stagnation Check (no tool steps for > N seconds)
    if (state.toolCalls.length > 0) {
      const lastCall = state.toolCalls[state.toolCalls.length - 1];
      const idleSec = (now - lastCall.timestamp) / 1000;
      if (idleSec >= stagnationSec) {
        return {
          tripped: true,
          guardType: 'stagnation_timeout',
          reason: `[Overnight Burn Guard] Agent idle stagnation detected (${Math.round(idleSec)}s without progress step > max ${stagnationSec}s). Auto-killed hanging background process.`,
        };
      }
    }

    // 3. Hourly Spend Velocity Cap (rolling 60-minute window, per run)
    this.pruneWindow(state);
    const windowSum = state.hourlySpendWindow.reduce((acc, w) => acc + w.cost, 0);
    // Legacy fallback: runs whose spend never flowed through recordSpend
    // (e.g. external cost tracking) still get a velocity check against the
    // cumulative total.
    const hourlySpend = state.hourlySpendWindow.length > 0 ? windowSum : state.cumulativeCost;

    if (hourlySpend >= maxHourly) {
      return {
        tripped: true,
        guardType: 'hourly_velocity_exceeded',
        reason: `[Overnight Burn Guard] Rolling 60-minute spend ($${hourlySpend.toFixed(2)}) exceeded max hourly velocity ceiling ($${maxHourly.toFixed(2)}/hr). Run force-killed.`,
      };
    }

    // 4. Overnight Hard Cap (quiet hours in server-local time, configurable)
    const startHour = opts.overnightWindowStartHour ?? 0;
    const endHour = opts.overnightWindowEndHour ?? 8;
    const localHour = new Date().getHours();
    const isOvernight = startHour <= endHour
      ? localHour >= startHour && localHour < endHour
      : localHour >= startHour || localHour < endHour; // window wrapping midnight
    if (isOvernight && state.cumulativeCost >= maxOvernight) {
      return {
        tripped: true,
        guardType: 'overnight_cap_exceeded',
        reason: `[Overnight Burn Guard] Cumulative spend ($${state.cumulativeCost.toFixed(2)}) hit hard overnight safety ceiling ($${maxOvernight.toFixed(2)}) during quiet hours (${localHour}:00).`,
      };
    }

    return { tripped: false };
  }
}
