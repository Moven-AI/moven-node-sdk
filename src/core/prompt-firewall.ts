/**
 * Moven AI Real-Time Prompt Injection & Jailbreak Firewall Engine
 * Sub-millisecond (<0.05ms) in-process inspection for autonomous agent inputs and tool arguments.
 * Intercepts Direct Overrides, Role Smuggling, Jailbreak Personas, and Prompt Exfiltration.
 */

export interface PromptFirewallConfig {
  enabled?: boolean;
  sensitivity?: 'low' | 'medium' | 'high' | 'max_paranoid';
  blockDirectOverrides?: boolean;
  blockJailbreaks?: boolean;
  blockSystemLeaks?: boolean;
  blockHiddenUnicode?: boolean;
  blockRoleSmuggling?: boolean;
  customBlockedPatterns?: (string | RegExp)[];
}

export interface PromptFirewallResult {
  isAttack: boolean;
  attackType?: 'DIRECT_INSTRUCTION_OVERRIDE' | 'JAILBREAK_PERSONA' | 'SYSTEM_PROMPT_LEAK' | 'HIDDEN_UNICODE_INJECTION' | 'DELIMITER_HIJACK' | 'CUSTOM_PATTERN_MATCH';
  confidence: number; // 0.0 to 1.0
  reason?: string;
  matchedSnippet?: string;
}

export class MovenPromptInjectionFirewall {
  // 1. Direct Instruction Overrides
  private static readonly DIRECT_OVERRIDE_PATTERNS = [
    /\b(?:ignore|disregard|override|forget|bypass)\s+(?:all\s+)?(?:previous|prior|above|existing|system)\s+(?:instructions|prompts|rules|directives|constraints|guidelines)\b/i,
    /\bfrom\s+now\s+on\s*[,:]?\s*(?:you\s+(?:are|will|must)|act\s+as|pretend\s+to\s+be)\b/i,
    /\byou\s+are\s+no\s+longer\s+(?:bound\s+by|restricted\s+by|an?\s+ai)\b/i,
    /\bstop\s+following\s+(?:your\s+)?(?:system|developer)\s+(?:prompt|instructions)\b/i,
    /\bnew\s+system\s+instruction\s*:\s*ignore\b/i,
  ];

  // 2. Jailbreak Personas & Uncensored Exploits
  private static readonly JAILBREAK_PATTERNS = [
    /\b(?:DAN|Do\s+Anything\s+Now|Jailbreak(?:ed)?\s+Mode|Developer\s+Mode\s+(?:enabled|activated)|AIM\s+persona|EvilBot|UncensoredAI|ChaosGPT)\b/i,
    /\bhypothetical\s+response\s+without\s+any\s+(?:safety|moral|ethical)\s+constraints\b/i,
    /\bfor\s+(?:educational|research)\s+purposes\s+only\s*,\s*bypass\b/i,
    /\byou\s+have\s+been\s+freed\s+from\s+your\s+rules\b/i,
  ];

  // 3. System Prompt Leaks & Exfiltration
  private static readonly SYSTEM_LEAK_PATTERNS = [
    /\b(?:output|repeat|print|reveal|show|echo|display|dump)\s+(?:your\s+)?(?:(?:initial|original|system|core|base)\s+)+(?:prompt|instructions|rules|guidelines)\b/i,
    /\brepeat\s+everything\s+(?:above|before\s+this\s+line|written\s+so\s+far)\b/i,
    /\bwhat\s+(?:is|was)\s+(?:the\s+)?(?:text|system\s+prompt)\s+(?:above|before)\b/i,
    /\bprint\s+the\s+hidden\s+(?:system\s+message|developer\s+instructions)\b/i,
  ];

  // 4. Role Smuggling & Delimiter Injection
  private static readonly ROLE_SMUGGLING_PATTERNS = [
    /<\/?(?:system|instruction|prompt|context|assistant|human)>/i,
    /<\|im_start\|>|<\|im_end\|>|\[INST\]|\[\/INST\]|<<SYS>>|<\/SYS>>/i,
    /```(?:markdown|system)\s*#\s*SYSTEM\s+OVERRIDE/i,
  ];

  // 5. Hidden Unicode Steganography (Zero-Width Characters)
  private static readonly ZERO_WIDTH_REGEX = /[\u200B\u200C\u200D\uFEFF\u2060]/;

  /**
   * Inspects a string or arbitrary argument object in <0.05ms before it reaches the model or tool.
   */
  public static inspect(input: unknown, config: PromptFirewallConfig = {}): PromptFirewallResult {
    if (config.enabled === false) {
      return { isAttack: false, confidence: 0 };
    }

    const text = this.extractSearchableText(input);
    if (!text || text.trim().length === 0) {
      return { isAttack: false, confidence: 0 };
    }

    const sensitivity = config.sensitivity || 'high';

    // 1. Hidden Zero-Width Unicode Steganography Check
    if (config.blockHiddenUnicode !== false) {
      if (this.ZERO_WIDTH_REGEX.test(text)) {
        return {
          isAttack: true,
          attackType: 'HIDDEN_UNICODE_INJECTION',
          confidence: 0.99,
          reason: 'Invisible zero-width Unicode characters detected in payload (potential prompt steganography exploit).',
          matchedSnippet: '[ZERO_WIDTH_UNICODE_PAYLOAD]',
        };
      }
    }

    // 2. Direct Instruction Override Check
    if (config.blockDirectOverrides !== false) {
      for (const pattern of this.DIRECT_OVERRIDE_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          return {
            isAttack: true,
            attackType: 'DIRECT_INSTRUCTION_OVERRIDE',
            confidence: 0.96,
            reason: `Malicious direct prompt override detected: '${match[0]}'`,
            matchedSnippet: match[0],
          };
        }
      }
    }

    // 3. Jailbreak & Persona Hijacking Check
    if (config.blockJailbreaks !== false) {
      for (const pattern of this.JAILBREAK_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          return {
            isAttack: true,
            attackType: 'JAILBREAK_PERSONA',
            confidence: 0.94,
            reason: `Known jailbreak / adversarial persona pattern detected: '${match[0]}'`,
            matchedSnippet: match[0],
          };
        }
      }
    }

    // 4. System Prompt Exfiltration Check
    if (config.blockSystemLeaks !== false) {
      for (const pattern of this.SYSTEM_LEAK_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          return {
            isAttack: true,
            attackType: 'SYSTEM_PROMPT_LEAK',
            confidence: 0.92,
            reason: `Unauthorized system prompt exfiltration attempt: '${match[0]}'`,
            matchedSnippet: match[0],
          };
        }
      }
    }

    // 5. Role Smuggling & Delimiter Injection Check
    if (config.blockRoleSmuggling !== false) {
      for (const pattern of this.ROLE_SMUGGLING_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          return {
            isAttack: true,
            attackType: 'DELIMITER_HIJACK',
            confidence: 0.98,
            reason: `System tag / delimiter smuggling detected: '${match[0]}'`,
            matchedSnippet: match[0],
          };
        }
      }
    }

    // 6. Custom Blocked Patterns
    if (config.customBlockedPatterns && Array.isArray(config.customBlockedPatterns)) {
      for (const p of config.customBlockedPatterns) {
        const regex = typeof p === 'string' ? new RegExp(p, 'i') : p;
        const match = text.match(regex);
        if (match) {
          return {
            isAttack: true,
            attackType: 'CUSTOM_PATTERN_MATCH',
            confidence: 0.95,
            reason: `Custom enterprise security rule triggered: '${match[0]}'`,
            matchedSnippet: match[0],
          };
        }
      }
    }

    // 7. Max Paranoid Sensitivity Heuristics (e.g. repeated imperatives or base64 blobs)
    if (sensitivity === 'max_paranoid') {
      const base64Match = text.match(/\b(?:[A-Za-z0-9+/]{4}){10,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\b/);
      if (base64Match && base64Match[0].length > 40) {
        return {
          isAttack: true,
          attackType: 'DELIMITER_HIJACK',
          confidence: 0.85,
          reason: 'High-entropy base64 payload detected under max paranoid inspection policy.',
          matchedSnippet: base64Match[0].substring(0, 20) + '...',
        };
      }
    }

    return {
      isAttack: false,
      confidence: 0.05,
    };
  }

  private static extractSearchableText(input: unknown): string {
    if (!input) return '';
    if (typeof input === 'string') return input;
    if (typeof input === 'number' || typeof input === 'boolean') return String(input);
    if (Array.isArray(input)) return input.map(item => this.extractSearchableText(item)).join(' ');
    if (typeof input === 'object') {
      try {
        return Object.values(input as Record<string, unknown>)
          .map(v => this.extractSearchableText(v))
          .join(' ');
      } catch {
        return '';
      }
    }
    return '';
  }
}
