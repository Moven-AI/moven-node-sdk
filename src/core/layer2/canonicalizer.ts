import crypto from 'crypto';
import { SemanticActionInput, CanonicalAction } from './types';

export class SemanticCanonicalizer {
  public static normalizeArguments(args: Record<string, any> | undefined): string {
    if (!args || typeof args !== 'object') return '';
    const sortedKeys = Object.keys(args).sort();
    return sortedKeys
      .map(k => {
        const val = args[k];
        const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
        return `${k}: ${valStr.trim()}`;
      })
      .join('\n');
  }

  public static canonicalGoal(goal: string): string {
    return `GOAL\n${(goal || '').trim()}`;
  }

  public static canonicalAction(tool: string, args: Record<string, any>): string {
    const formattedArgs = this.normalizeArguments(args);
    return `ACTION\nTool: ${tool.trim()}\n${formattedArgs}`.trim();
  }

  public static canonicalExpectedResult(expected: string): string {
    return `EXPECTED RESULT\n${(expected || '').trim()}`;
  }

  public static canonicalResult(result: any): string {
    const resStr = typeof result === 'object' ? JSON.stringify(result) : String(result ?? '');
    return `RESULT\n${resStr.trim()}`;
  }

  public static canonicalFact(fact: string): string {
    return `FACT\n${(fact || '').trim()}`;
  }

  public static extractArgumentBreakdown(tool: string, args: Record<string, any>): {
    entities: string[];
    attributes: string[];
    intents: string[];
  } {
    const entities: string[] = [];
    const attributes: string[] = [];
    const intents: string[] = [tool.toLowerCase().replace(/[^a-z0-9]/g, '_')];

    if (!args) return { entities, attributes, intents };

    for (const [key, rawVal] of Object.entries(args)) {
      const k = key.toLowerCase();
      const val = String(rawVal || '').toLowerCase().trim();
      if (!val) continue;

      const words = val.split(/\s+/).filter(w => w.length > 1);

      if (
        k.includes('email') ||
        k.includes('phone') ||
        k.includes('status') ||
        k.includes('type') ||
        k.includes('role') ||
        k.includes('attr') ||
        k.includes('field') ||
        k.includes('property')
      ) {
        attributes.push(`${k}:${val}`);
        attributes.push(val);
      } else {
        // Query, path, search or general string values
        for (const w of words) {
          if (w.includes('email') || w.includes('phone') || w.includes('status') || w.includes('address')) {
            attributes.push(w);
          } else {
            entities.push(w);
          }
        }
        if (val.length > 0) {
          entities.push(val);
        }
      }
    }

    return {
      entities: Array.from(new Set(entities)),
      attributes: Array.from(new Set(attributes)),
      intents,
    };
  }

  public static canonicalize(input: SemanticActionInput): CanonicalAction {
    const goalText = this.canonicalGoal(input.goal || 'Complete agent objective');
    const actionText = this.canonicalAction(input.tool, input.arguments || {});
    const expectedResultText = this.canonicalExpectedResult(
      input.expectedOutcome || `${input.tool} result for ${JSON.stringify(input.arguments || {})}`
    );

    const { entities, attributes, intents } = this.extractArgumentBreakdown(input.tool, input.arguments || {});

    const hashPayload = `${goalText}---${actionText}---${expectedResultText}`;
    const hash = crypto.createHash('sha256').update(hashPayload).digest('hex');

    return {
      rawTool: input.tool,
      rawArgs: input.arguments || {},
      canonicalGoal: goalText,
      canonicalActionText: actionText,
      canonicalExpectedResult: expectedResultText,
      entityTokens: entities,
      attributeTokens: attributes,
      intentTokens: intents,
      hash,
    };
  }
}
