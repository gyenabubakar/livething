/* oxlint-disable @typescript-eslint/no-explicit-any */
/**
 * Runtime half of the rate-limit primitive.
 *
 * Holds the resolved scope→rule plan (built once at engine boot) and a
 * per-bucket token state map. Each incoming frame routes to one rule:
 *
 *   1. If a per-event override exists for the frame's scope, that rule wins.
 *   2. Otherwise the scope's default rule wins.
 *   3. If neither exists (or the rule is disabled), the frame passes through.
 *
 * Buckets are keyed by `<ruleId>|<perKey>` — each rule has its own bucket
 * space, so per-event overrides do not share buckets with the scope default.
 */

/**
 * One concrete rate-limit rule, after cascade resolution.
 *
 * - `id` — unique numeric tag used in the bucket key. Two rules can have the
 *   same `windowMs` / `max` but different ids and so different buckets.
 * - `per` — bucket-key extractor. Default is `ctx.connection.id` (connection
 *   id), so different connections never share a bucket.
 */
export interface RuleInstance {
  readonly id: number;
  readonly windowMs: number;
  readonly max: number;
  readonly per: (ctx: any) => string;
}

/**
 * The resolved plan produced at build time. Maps every scope to its default
 * rule (or `null` if rate limiting is disabled there) plus any per-event
 * overrides for that scope.
 *
 * Scope keys:
 * - `'top'` — top-level events.
 * - `'channel:<key>'` — events inside the channel whose family key (or
 *   static name) is `<key>`.
 */
export interface ResolvedRateLimitPlan {
  readonly scopeRules: ReadonlyMap<string, RuleInstance | null>;
  readonly eventOverrides: ReadonlyMap<string, ReadonlyMap<string, RuleInstance | null>>;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Identifies the scope a given incoming frame landed in, using the ctx
 * fields populated by the engine when it builds a scoped connection context.
 */
export function resolveScopeKey(ctx: any): string {
  const ch = ctx?.channel as { name?: string; family?: string | null } | undefined;
  const chKey = ch ? (ch.family ?? ch.name) : undefined;
  if (chKey) return `channel:${chKey}`;
  return 'top';
}

/**
 * Token-bucket store. One instance per engine boot; lives in memory only
 * (cross-hibernation persistence is out of scope for v1).
 */
export class RateLimitRuntime {
  private readonly buckets = new Map<string, BucketState>();
  private readonly plan: ResolvedRateLimitPlan;
  private readonly now: () => number;

  constructor(plan: ResolvedRateLimitPlan, now: () => number = Date.now) {
    this.plan = plan;
    this.now = now;
  }

  /**
   * Resolve the rule that applies to this frame, then consume a token.
   * Returns `null` to let the frame through, or `{ retryAfterMs }` to reject.
   * `retryAfterMs` is rounded up to the next whole millisecond so a client
   * backing off by it has enough time for the next token to become available.
   */
  check(ctx: any, event: string): { retryAfterMs: number } | null {
    const scopeKey = resolveScopeKey(ctx);

    const overrideMap = this.plan.eventOverrides.get(scopeKey);
    const rule = overrideMap?.has(event)
      ? overrideMap.get(event)!
      : (this.plan.scopeRules.get(scopeKey) ?? null);
    if (!rule) return null;

    const perKey = rule.per(ctx);
    const bucketKey = `${rule.id}|${perKey}`;
    const now = this.now();
    const refillRate = rule.max / rule.windowMs;

    const state = this.buckets.get(bucketKey);
    let tokens: number;
    if (!state) {
      tokens = rule.max;
    } else {
      const elapsed = Math.max(0, now - state.lastRefillMs);
      tokens = Math.min(rule.max, state.tokens + elapsed * refillRate);
    }

    if (tokens < 1) {
      const msUntilOne = (1 - tokens) / refillRate;
      this.buckets.set(bucketKey, { tokens, lastRefillMs: now });
      return { retryAfterMs: Math.max(1, Math.ceil(msUntilOne)) };
    }

    this.buckets.set(bucketKey, { tokens: tokens - 1, lastRefillMs: now });
    return null;
  }
}
