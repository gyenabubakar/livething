/* oxlint-disable @typescript-eslint/no-explicit-any */
import { capability } from '~/_define/capability.ts';
import { resolvePlan } from '~/rate-limit/plan.ts';
import { rateLimit as rateLimitFactory } from '~/rate-limit/rate-limit.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';

/**
 * The global rate-limit rule. It applies to every event unless a per-handler
 * `rateLimit` override replaces it. Omit it to enable rate limiting with no
 * global default — useful when only a few handlers set their own limit.
 */
export interface RateLimitGlobalConfig {
  /** Length of the rolling window, in milliseconds. Defaults to 60000. */
  readonly windowMs?: number;
  /** Maximum events allowed per window. Defaults to 60. */
  readonly max?: number;
  /**
   * Pick the budget key from the connection. Defaults to one budget per
   * connection; return `ctx.identity` to share one budget across a user's
   * sockets.
   */
  readonly per?: (ctx: any) => string;
}

/** A `rateLimit(...)` capability, carrying its global rule and intercept builder for assembly. */
export interface RateLimitCapability extends Capability<{}, never, never> {
  /** The global rule, or `undefined` when only per-handler limits apply. @internal */
  readonly __rateLimit: RateLimitConfig | undefined;
  /**
   * Build the rate-limit intercept from the global rule plus the per-handler
   * overrides collected at assembly, or `null` when nothing limits anything.
   * Kept on the capability so the core never imports the rate-limit engine.
   * @internal
   */
  readonly __buildRateLimit: (overrides: ReadonlyMap<string, RateLimitConfig>) => Primitive | null;
}

/**
 * Enable rate limiting. Call it with a rule to set a global default that every
 * event shares (`rateLimit({ windowMs, max })`), or with no argument to enable
 * rate limiting without a global default so only handlers that set their own
 * `rateLimit` override are limited. A handler override can raise, lower, or
 * disable the limit for one event.
 *
 * Listing this capability is required to use any rate limit, including a
 * per-handler override.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { rateLimit } from '@wskit/server/rate-limit';
 *
 * const base = define({
 *   env: t<Env>(),
 *   capabilities: [rateLimit({ windowMs: 60_000, max: 100 })],
 * });
 * ```
 */
export function rateLimit(config?: RateLimitGlobalConfig): RateLimitCapability {
  const rule: RateLimitConfig | undefined = config ? { enabled: true, ...config } : undefined;
  const cap = capability<{}>([]) as RateLimitCapability;
  const writable = cap as {
    __rateLimit: RateLimitConfig | undefined;
    __buildRateLimit: (overrides: ReadonlyMap<string, RateLimitConfig>) => Primitive | null;
  };
  writable.__rateLimit = rule;
  writable.__buildRateLimit = (overrides) => {
    const plan = resolvePlan({
      contractRateLimit: rule,
      definitions: [],
      overrides: overrides.size > 0 ? new Map([['top', new Map(overrides)]]) : new Map(),
    });
    return plan ? rateLimitFactory(plan) : null;
  };
  return cap;
}
