import { MovenRunState } from './run-state';

export interface BurnGuardOptions {
  maxHourlySpendDollar?: number;       // default: $10.00/hour
  maxRunDurationMinutes?: number;      // default: 60 minutes max wall-clock duration
  maxOvernightTotalDollar?: number;    // default: $25.00 hard cap overnight (12am-8am)
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
  private static hourlySpendWindow: { timestamp: number; cost: number }[] = [];

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

    // 3. Hourly Spend Velocity Cap (Rolling 60-minute window)
    // Clean old window records older than 60 minutes
    const windowStart = now - 60 * 60 * 1000;
    this.hourlySpendWindow = this.hourlySpendWindow.filter(w => w.timestamp >= windowStart);
    
    // Add current run's cost to window sum
    const totalHourlySpend = this.hourlySpendWindow.reduce((acc, w) => acc + w.cost, 0) + state.cumulativeCost;

    if (totalHourlySpend >= maxHourly) {
      return {
        tripped: true,
        guardType: 'hourly_velocity_exceeded',
        reason: `[Overnight Burn Guard] Rolling 60-minute spend ($${totalHourlySpend.toFixed(2)}) exceeded max hourly velocity ceiling ($${maxHourly.toFixed(2)}/hr). Run force-killed.`,
      };
    }

    // 4. Overnight Hard Cap (12 AM to 8 AM local time)
    const localHour = new Date().getHours();
    const isOvernight = localHour >= 0 && localHour < 8;
    if (isOvernight && state.cumulativeCost >= maxOvernight) {
      return {
        tripped: true,
        guardType: 'overnight_cap_exceeded',
        reason: `[Overnight Burn Guard] Cumulative spend ($${state.cumulativeCost.toFixed(2)}) hit hard overnight safety ceiling ($${maxOvernight.toFixed(2)}) during quiet hours (${localHour}:00).`,
      };
    }

    return { tripped: false };
  }

  public static recordSpend(cost: number) {
    if (cost > 0) {
      this.hourlySpendWindow.push({ timestamp: Date.now(), cost });
    }
  }
}
