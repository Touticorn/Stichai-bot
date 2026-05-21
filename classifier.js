/**
 * classifier.js — Intent classification for user input.
 * Exposes a global `Classifier` object for non-ESM consumption.
 */

(function (global) {
  'use strict';

  // ─── Intent Rule Definitions ──────────────────────────────────────────────

  const INTENT_RULES = [
    {
      intent: 'greeting',
      patterns: [
        /\b(hi|hello|hey|howdy|sup|what'?s up|good morning|good afternoon|good evening|greetings)\b/i
      ],
      priority: 10
    },
    {
      intent: 'farewell',
      patterns: [
        /\b(bye|goodbye|see you|later|take care|farewell|so long|catch you later|cya)\b/i
      ],
      priority: 10
    },
    {
      intent: 'thanks',
      patterns: [
        /\b(thanks|thank you|thank u|thx|ty|cheers|much appreciated|appreciate it)\b/i
      ],
      priority: 10
    },
    {
      intent: 'help',
      patterns: [
        /\b(help|assist|support|what can you do|how does this work|what are your features|capabilities)\b/i
      ],
      priority: 8
    },
    {
      intent: 'affirmative',
      patterns: [
        /^\s*(yes|yep|yeah|yup|sure|ok|okay|correct|absolutely|definitely|of course|sounds good|alright)\s*[.!]?\s*$/i
      ],
      priority: 7
    },
    {
      intent: 'negative',
      patterns: [
        /^\s*(no|nope|nah|not really|negative|never|i don'?t think so)\s*[.!]?\s*$/i
      ],
      priority: 7
    },
    {
      intent: 'question',
      patterns: [
        /\?$/,
        /^(what|where|when|why|who|how|which|whose|whom)\b/i
      ],
      priority: 5
    },
    {
      intent: 'complaint',
      patterns: [
        /\b(broken|doesn'?t work|not working|issue|problem|bug|error|fail|failed|failing|wrong|incorrect|bad|terrible|awful|disappointed)\b/i
      ],
      priority: 9
    },
    {
      intent: 'cancel',
      patterns: [
        /\b(cancel|stop|abort|quit|exit|reset|restart|start over|never mind|nevermind)\b/i
      ],
      priority: 9
    }
  ];

  const FALLBACK_INTENT = 'unknown';

  // ─── Private Helpers ──────────────────────────────────────────────────────

  let _initialized = false;
  let _customRules = [];

  function _normalizeText(text) {
    return text.trim().replace(/\s+/g, ' ');
  }

  function _scoreRule(normalizedText, rule) {
    for (const pattern of rule.patterns) {
      if (pattern.test(normalizedText)) {
        return rule.priority;
      }
    }
    return 0;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * init(options)
   * Bootstrap the classifier. Optionally register custom rules.
   *
   * @param {object}   [options]
   * @param {Array}    [options.customRules]  Array of {intent, patterns, priority} objects.
   * @returns {void}
   */
  function init(options) {
    const opts = options || {};

    if (opts.customRules && Array.isArray(opts.customRules)) {
      for (const rule of opts.customRules) {
        if (typeof rule.intent !== 'string' || !Array.isArray(rule.patterns)) {
          console.warn('[Classifier] Skipping invalid custom rule:', rule);
          continue;
        }
        _customRules.push({
          intent: rule.intent,
          patterns: rule.patterns,
          priority: typeof rule.priority === 'number' ? rule.priority : 5
        });
      }
    }

    _initialized = true;
    console.log('[Classifier] Initialized. Rules:', INTENT_RULES.length + _customRules.length);
  }

  /**
   * classify(text, sessionContext)
   * Classify user text into an intent, optionally using session context.
   *
   * @param {string} text            Raw user input.
   * @param {object} [sessionContext] Session state snapshot for context-aware classification.
   * @returns {{ intent: string, confidence: number, raw: string }}
   */
  function classify(text, sessionContext) {
    if (!_initialized) {
      throw new Error('[Classifier] classify() called before init(). Call Classifier.init() first.');
    }

    if (typeof text !== 'string') {
      throw new TypeError('[Classifier] classify() requires a string input.');
    }

    const normalized = _normalizeText(text);

    if (normalized === '') {
      return { intent: FALLBACK_INTENT, confidence: 0, raw: text };
    }

    const allRules = INTENT_RULES.concat(_customRules);
    let bestIntent = FALLBACK_INTENT;
    let bestScore = 0;

    for (const rule of allRules) {
      const score = _scoreRule(normalized, rule);
      if (score > bestScore) {
        bestScore = score;
        bestIntent = rule.intent;
      }
    }

    // Context boost: if session has a current intent and no strong match found,
    // carry forward context to allow follow-up handling
    const ctx = sessionContext || {};
    if (bestScore === 0 && ctx.currentIntent && ctx.currentIntent !== FALLBACK_INTENT) {
      return {
        intent: 'follow_up',
        confidence: 0.3,
        raw: text,
        previousIntent: ctx.currentIntent
      };
    }

    // Normalize confidence to 0-1 range (max priority is 10)
    const maxPriority = 10;
    const confidence = bestScore > 0 ? Math.min(bestScore / maxPriority, 1) : 0;

    return {
      intent: bestIntent,
      confidence: confidence,
      raw: text
    };
  }

  /**
   * addRule(rule)
   * Dynamically register an intent rule after initialization.
   *
   * @param {{ intent: string, patterns: RegExp[], priority?: number }} rule
   */
  function addRule(rule) {
    if (!rule || typeof rule.intent !== 'string' || !Array.isArray(rule.patterns)) {
      throw new TypeError('[Classifier] addRule() requires { intent: string, patterns: RegExp[] }.');
    }
    _customRules.push({
      intent: rule.intent,
      patterns: rule.patterns,
      priority: typeof rule.priority === 'number' ? rule.priority : 5
    });
    console.log('[Classifier] Rule added for intent:', rule.intent);
  }

  /**
   * getSupportedIntents()
   * Returns the list of all registered intent names.
   *
   * @returns {string[]}
   */
  function getSupportedIntents() {
    const all = INTENT_RULES.concat(_customRules);
    return [...new Set(all.map(r => r.intent))];
  }

  // ─── Export ───────────────────────────────────────────────────────────────

  const Classifier = {
    init,
    classify,
    addRule,
    getSupportedIntents
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Classifier;
  } else {
    global.Classifier = Classifier;
  }

}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
