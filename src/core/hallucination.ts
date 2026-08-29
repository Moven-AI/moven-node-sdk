import { MovenRunState } from './run-state';
import { safeStringify } from './safe-json';

export interface HallucinationResult {
  tripped: boolean;
  reason?: string;
  hallucinationType?: 'invented_tool' | 'placeholder_args' | 'phantom_resource' | 'contradictory_execution';
  toolName?: string;
  toolArgs?: any;
  confidenceScore?: number; // 0.0 to 1.0 confidence that call is hallucinated
}

export class MovenHallucinationDetector {
  
  /**
   * Evaluates the current agent state for AI Hallucination patterns
   */
  public static evaluate(state: MovenRunState): HallucinationResult {
    const calls = state.toolCalls;
    if (calls.length === 0) return { tripped: false };

    const lastCall = calls[calls.length - 1];
    const allowedTools = state.options.allowedTools;

    // 1. Invented / Unregistered Tool Name Hallucination
    if (allowedTools && allowedTools.length > 0) {
      if (!allowedTools.includes(lastCall.toolName)) {
        return {
          tripped: true,
          hallucinationType: 'invented_tool',
          reason: `AI Hallucination Detected: Agent attempted to execute un-registered / invented tool '${lastCall.toolName}'.`,
          toolName: lastCall.toolName,
          toolArgs: lastCall.args,
          confidenceScore: 0.99,
        };
      }
    }

    // 2. Placeholder / Stringified Undefined Parameter Hallucination
    const placeholderMatch = this.detectPlaceholderArguments(lastCall.args);
    if (placeholderMatch.detected) {
      return {
        tripped: true,
        hallucinationType: 'placeholder_args',
        reason: `AI Hallucination Detected: Agent passed hallucinated/placeholder argument '${placeholderMatch.foundKey}: "${placeholderMatch.foundValue}"' to tool '${lastCall.toolName}'.`,
        toolName: lastCall.toolName,
        toolArgs: lastCall.args,
        confidenceScore: 0.95,
      };
    }

    // 3. Phantom Resource Pursuit (Ignoring Previous Tool Failure Result)
    if (calls.length >= 2) {
      const prevCall = calls[calls.length - 2];
      if (prevCall.result) {
        const resultStr = typeof prevCall.result === 'string' ? prevCall.result : safeStringify(prevCall.result);
        // Word-bounded status codes so IDs/amounts like '1404' or
        // 'ticket_40423' never match; explicit not-found phrases instead of
        // a bare 'failed' substring.
        const isErrorResult = /\b(400|401|403|404|410|422|500|502|503)\b|not found|does not exist|no such|enoent|unauthorized|access denied|permission denied/i.test(resultStr);

        if (isErrorResult) {
          // Extract argument values present in both calls (e.g., resource IDs)
          const extractArgValues = (obj: any): string[] => {
            if (!obj || typeof obj !== 'object') return [];
            let vals: string[] = [];
            for (const val of Object.values(obj)) {
              if (typeof val === 'string' && val.length >= 3 && !['true', 'false', 'null', 'undefined'].includes(val.toLowerCase())) {
                vals.push(val);
              } else if (typeof val === 'object') {
                vals = vals.concat(extractArgValues(val));
              }
            }
            return vals;
          };

          const prevValues = extractArgValues(prevCall.args);
          const currentArgsStr = safeStringify(lastCall.args);

          for (const val of prevValues) {
            if (currentArgsStr.includes(val)) {
              // Count how many consecutive times this failed resource is pursued.
              // prev call + current call = 2 → ONE legitimate retry (e.g.
              // eventual consistency, transient 404) is still allowed; the
              // breaker fires from the THIRD pursuit onwards.
              const failedPursuits = calls.filter(c => safeStringify(c.args).includes(val)).length;
              if (failedPursuits >= 3) {
                return {
                  tripped: true,
                  hallucinationType: 'phantom_resource',
                  reason: `AI Hallucination Detected: Agent is pursuing non-existent resource '${val}' after tool '${prevCall.toolName}' explicitly returned an error.`,
                  toolName: lastCall.toolName,
                  toolArgs: lastCall.args,
                  confidenceScore: 0.90,
                };
              }
            }
          }
        }
      }
    }

    // 4. Repeated Single Tool Parameter Drift Loop (Hallucinating fake iterations)
    if (calls.length >= 4) {
      const recent4 = calls.slice(-4);
      const sameTool = recent4.every(c => c.toolName === recent4[0].toolName);
      if (sameTool) {
        // Check if arguments are slightly shifting numbers or hallucinating incrementing indexes without tool result changes
        const argKeys = Object.keys(recent4[0].args || {});
        if (argKeys.length > 0) {
          const numericDrifts = argKeys.some(key => {
            const vals = recent4.map(c => c.args?.[key]);
            return vals.every(v => typeof v === 'number') && new Set(vals).size === 4;
          });

          // Check if previous 3 tool results were empty or identical error
          const resultsIdentical = recent4.slice(0, 3).every(c => 
            c.result && safeStringify(c.result) === safeStringify(recent4[0].result)
          );

          if (numericDrifts && resultsIdentical && recent4[0].result !== undefined) {
            return {
              tripped: true,
              hallucinationType: 'contradictory_execution',
              reason: `AI Hallucination Detected: Agent is looping with shifting numerical arguments to tool '${recent4[0].toolName}' despite identical empty/static tool outputs.`,
              toolName: lastCall.toolName,
              toolArgs: lastCall.args,
              confidenceScore: 0.88,
            };
          }
        }
      }
    }

    return { tripped: false };
  }

  /**
   * Helper to detect stringified "undefined", "null", placeholder tokens inside tool arguments
   */
  private static detectPlaceholderArguments(args: any): { detected: boolean; foundKey?: string; foundValue?: string } {
    if (!args || typeof args !== 'object') return { detected: false };

    const invalidPatterns = [
      /^undefined$/i,
      /^null$/i,
      /^\[object Object\]$/i,
      /^YOUR_.*_HERE$/i,
      /^TODO_.*$/i,
      /^PLACEHOLDER$/i,
      /^00000000-0000-0000-0000-000000000000$/
    ];

    const checkValue = (obj: any, parentKey = ''): { detected: boolean; foundKey?: string; foundValue?: string } => {
      if (typeof obj === 'string') {
        const trimmed = obj.trim();
        for (const pattern of invalidPatterns) {
          if (pattern.test(trimmed)) {
            return { detected: true, foundKey: parentKey, foundValue: trimmed };
          }
        }
      } else if (typeof obj === 'object' && obj !== null) {
        for (const key of Object.keys(obj)) {
          const res = checkValue(obj[key], key);
          if (res.detected) return res;
        }
      }
      return { detected: false };
    };

    return checkValue(args);
  }
}
