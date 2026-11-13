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
 * Each rule has its own bucket space, so per-event overrides do not share
 * buckets with the scope default. A connection's own budget and a shared `per`
 * key are kept apart, so closing a connection never erases a shared budget.
 */

/**
 * One concrete rate-limit rule, after cascade resolution.
 *
 * - `id` — unique numeric tag used in the bucket key. Two rules can have the
 *   same `windowMs` / `maxMessages` but different ids and so different buckets.
 * - `maxBytes` — the byte budget per window, or none.
 * - `per` — bucket-key extractor. Default is `ctx.connection.id` (connection
 *   id), so different connections never share a bucket.
 */
export interface RuleInstance {
  readonly id: number;
  readonly windowMs: number;
  readonly maxMessages: number;
  readonly maxBytes?: number;
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
  /** The bytes left, when the rule has `maxBytes`. */
  bytes: number;
  lastRefillMs: number;
  /** When both budgets are full again. From then on it equals a fresh bucket, so it can go. */
  fullAtMs: number;
}

const SWEEP_INTERVAL_MS = 60_000;

/** The default budget key: one budget per connection. */
export function connectionBudgetKey(ctx: any): string {
  return String(ctx?.connection?.id ?? '');
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
  private readonly ruleIds: number[];
  private lastSweepMs: number;

  constructor(plan: ResolvedRateLimitPlan, now: () => number = Date.now) {
    this.plan = plan;
    this.now = now;
    this.lastSweepMs = now();
    const rules = [
      ...plan.scopeRules.values(),
      ...[...plan.eventOverrides.values()].flatMap((overrides) => [...overrides.values()]),
    ];
    this.ruleIds = [...new Set(rules.flatMap((rule) => (rule ? [rule.id] : [])))];
  }

  /** How many buckets are held in memory. */
  get size(): number {
    return this.buckets.size;
  }

  /** Drop the per-connection buckets of a connection that has closed. */
  forgetConnection(connectionId: string): void {
    for (const id of this.ruleIds) this.buckets.delete(`${id}|connection|${connectionId}`);
  }

  /**
   * Buckets keyed by something other than the connection (`per: ctx.user.id`)
   * outlive any one socket. Drop the ones that have refilled, at most once
   * per interval, so a long-running server does not keep every key it saw.
   */
  private sweep(now: number): void {
    if (now - this.lastSweepMs < SWEEP_INTERVAL_MS) return;

    this.lastSweepMs = now;
    for (const [key, state] of this.buckets) {
      if (now >= state.fullAtMs) this.buckets.delete(key);
    }
  }

  /**
   * Resolve the rule that applies to this frame, then take one message and `size` bytes from
   * its budgets. Returns `null` to let the frame through, or `{ retryAfterMs }` to reject.
   * `retryAfterMs` is the time until both budgets have enough, rounded up to a whole
   * millisecond and never less than 1000, so a client backing off by it has enough time.
   */
  check(ctx: any, event: string, size: number): { retryAfterMs: number } | null {
    const scopeKey = resolveScopeKey(ctx);

    const overrideMap = this.plan.eventOverrides.get(scopeKey);
    const rule = overrideMap?.has(event)
      ? overrideMap.get(event)!
      : (this.plan.scopeRules.get(scopeKey) ?? null);
    if (!rule) return null;

    const perKey = rule.per === connectionBudgetKey ? '' : rule.per(ctx);
    const bucketKey = perKey
      ? `${rule.id}|shared|${perKey}`
      : `${rule.id}|connection|${connectionBudgetKey(ctx)}`;
    const now = this.now();
    this.sweep(now);

    const { windowMs, maxMessages } = rule;
    const maxBytes = rule.maxBytes ?? 0;
    const state = this.buckets.get(bucketKey);
    const elapsed = state ? Math.max(0, now - state.lastRefillMs) : 0;
    const tokens = state
      ? Math.min(maxMessages, state.tokens + (elapsed * maxMessages) / windowMs)
      : maxMessages;

    const bytes = state
      ? Math.min(maxBytes, state.bytes + (elapsed * maxBytes) / windowMs)
      : maxBytes;
    // A frame bigger than the whole byte budget costs all of it, so it passes when the budget is full.
    const byteCost = Math.min(size, maxBytes);

    const wait = Math.max(
      msUntilRefilled(1 - tokens, maxMessages, windowMs),
      msUntilRefilled(byteCost - bytes, maxBytes, windowMs),
    );
    const next = wait > 0 ? { tokens, bytes } : { tokens: tokens - 1, bytes: bytes - byteCost };
    const msUntilFull = Math.max(
      msUntilRefilled(maxMessages - next.tokens, maxMessages, windowMs),
      msUntilRefilled(maxBytes - next.bytes, maxBytes, windowMs),
    );
    this.buckets.set(bucketKey, { ...next, lastRefillMs: now, fullAtMs: now + msUntilFull });

    return wait > 0 ? { retryAfterMs: Math.max(1_000, Math.ceil(wait)) } : null;
  }
}

/** How long a budget of `max` per `windowMs` takes to refill `missing`. Exact for whole numbers. */
function msUntilRefilled(missing: number, max: number, windowMs: number): number {
  return missing > 0 ? (missing * windowMs) / max : 0;
}
