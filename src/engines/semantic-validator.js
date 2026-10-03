import { logger, PerformanceTimer } from '../utils/logger.js';

/**
 * Configurable Semantic Constraint Validator
 *
 * Sends each validation to the rapid-llm-proxy daemon's `/api/complete` as
 * process `constraint-monitor`; the daemon's `bg-constraint-monitor` route
 * picks the model, and the daemon owns fallback and token accounting.
 * Keeps domain logic: prompt building, response parsing, result caching.
 *
 * Usage:
 *   const validator = new SemanticValidator(config);
 *   const result = await validator.validateConstraint(constraintId, regexMatch, context);
 */

const PROCESS_TAG = 'constraint-monitor';
const REQUEST_TIMEOUT_MS = 30000;

/** Same precedence as every other proxy client in coding (see CLAUDE.md). */
function resolveProxyCompleteUrl() {
  const base = process.env.RAPID_LLM_PROXY_URL
    ?? process.env.LLM_CLI_PROXY_URL
    ?? process.env.LLM_PROXY_URL
    ?? `http://localhost:${process.env.LLM_CLI_PROXY_PORT ?? '12435'}`;
  return base.endsWith('/api/complete') ? base : `${base.replace(/\/+$/, '')}/api/complete`;
}

export class SemanticValidator {
  constructor(config = {}) {
    this.config = config;

    // Result cache: the same match in the same context gets the same verdict
    this.cache = new Map();
    this.cacheMaxSize = config.cacheMaxSize || 1000;
    this.cacheTTL = config.cacheTTL || 3600000;
    this.cacheHits = 0;
    this.cacheMisses = 0;

    // Performance tracking
    this.stats = {
      totalValidations: 0,
      byProvider: {},
      byConstraint: {},
      averageLatency: 0
    };
  }

  /**
   * One completion from the proxy daemon. Throws on a non-2xx reply.
   */
  async complete(prompt) {
    const response = await fetch(resolveProxyCompleteUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        process: PROCESS_TAG,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 200,
        temperature: 0.1,
        responseFormat: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`proxy HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const data = await response.json();
    return {
      content: typeof data.content === 'string' ? data.content : '',
      provider: data.provider || 'unknown',
      model: data.model || 'unknown',
    };
  }

  /**
   * Validate a constraint match using semantic analysis
   *
   * @param {string} constraintId - Constraint identifier
   * @param {object} regexMatch - Regex match object with matches array
   * @param {object} context - Context including content, filePath, constraint details
   * @returns {Promise<object>} Validation result with isViolation, confidence, reasoning
   */
  async validateConstraint(constraintId, regexMatch, context) {
    const timer = new PerformanceTimer(`semantic-validation-${constraintId}`);

    try {
      this.stats.totalValidations++;

      const prompt = this.buildValidationPrompt(constraintId, regexMatch, context);

      const cached = this.cache.get(prompt);
      if (cached && Date.now() - cached.at < this.cacheTTL) {
        this.cacheHits++;
        timer.end('cached');
        return cached.result;
      }
      this.cacheMisses++;

      const result = await this.complete(prompt);

      // Parse the LLM response
      const parsed = this.parseValidationResponse(result.content);
      if (!parsed.fallback) this.remember(prompt, parsed);

      // Update stats
      const duration = timer.duration;
      this.updateStats(result.provider, constraintId, duration);

      timer.end('completed');

      // Warn if too slow
      if (duration > 300) {
        logger.warn(`Slow semantic validation: ${duration}ms`, {
          constraintId,
          provider: result.provider,
          model: result.model
        });
      }

      return parsed;

    } catch (error) {
      timer.end('failed', { error: error.message });
      logger.error('Semantic validation failed:', error);

      // Return fallback (accept regex match)
      return this.createFallbackResult(true);
    }
  }

  /**
   * Cache a verdict, evicting the oldest entry when full
   */
  remember(prompt, result) {
    if (this.cache.size >= this.cacheMaxSize) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(prompt, { result, at: Date.now() });
  }

  /**
   * Build validation prompt for semantic analysis
   */
  buildValidationPrompt(constraintId, regexMatch, context) {
    const { content, filePath, constraint } = context;

    // Extract relevant context around the match
    const matchedText = regexMatch.matches ? regexMatch.matches[0] : '';
    const matchIndex = content.indexOf(matchedText);
    const contextBefore = content.substring(Math.max(0, matchIndex - 200), matchIndex);
    const contextAfter = content.substring(matchIndex + matchedText.length, matchIndex + matchedText.length + 200);

    return `You are validating a potential constraint violation.

CONSTRAINT: ${constraint.message}
PATTERN MATCHED: "${matchedText}"
FILE: ${filePath || 'unknown'}

CONTEXT:
...${contextBefore}
>>> ${matchedText} <<<
${contextAfter}...

QUESTION: Is this a TRUE violation of the constraint, or a FALSE POSITIVE?

Consider:
- The intent and purpose of the matched code
- Whether this is test code, examples, or legitimate use
- The broader context of what the code is trying to achieve
- If this creates the actual problem the constraint is trying to prevent

Respond with JSON only:
{
  "isViolation": true|false,
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation of your determination"
}`;
  }

  /**
   * Parse validation response from any provider
   */
  parseValidationResponse(response) {
    try {
      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        isViolation: Boolean(parsed.isViolation),
        confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
        reasoning: parsed.reasoning || 'No reasoning provided',
        semanticOverride: !parsed.isViolation, // If not a violation, we're overriding regex
        rawResponse: response
      };

    } catch (error) {
      logger.warn('Failed to parse validation response:', { error: error.message, response });

      // On parse failure, assume regex was correct
      return this.createFallbackResult(true);
    }
  }

  /**
   * Stats tracking
   */
  updateStats(provider, constraintId, duration) {
    if (!this.stats.byProvider[provider]) {
      this.stats.byProvider[provider] = { count: 0, totalLatency: 0 };
    }
    this.stats.byProvider[provider].count++;
    this.stats.byProvider[provider].totalLatency += duration;

    if (!this.stats.byConstraint[constraintId]) {
      this.stats.byConstraint[constraintId] = { count: 0, totalLatency: 0 };
    }
    this.stats.byConstraint[constraintId].count++;
    this.stats.byConstraint[constraintId].totalLatency += duration;

    // Update average
    const totalLatency = Object.values(this.stats.byProvider).reduce((sum, p) => sum + p.totalLatency, 0);
    this.stats.averageLatency = totalLatency / this.stats.totalValidations;
  }

  /**
   * Create fallback result when semantic validation unavailable
   */
  createFallbackResult(acceptRegexMatch) {
    return {
      isViolation: acceptRegexMatch,
      confidence: 0.5,
      reasoning: 'Fallback to regex-only (semantic validation unavailable)',
      semanticOverride: false,
      fallback: true
    };
  }

  /**
   * Get validation statistics
   */
  getStats() {
    const lookups = this.cacheHits + this.cacheMisses;
    return {
      ...this.stats,
      cache: {
        size: this.cache.size,
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate: lookups > 0 ? this.cacheHits / lookups : 0
      }
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    logger.info('Semantic validator cache cleared');
  }
}
