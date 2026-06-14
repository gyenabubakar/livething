/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { resolvePlan } from '~/rate-limit/plan.ts';
import { rateLimit as rateLimitFactory } from '~/rate-limit/rate-limit.ts';
import type { Capability } from '~/_define/capability.ts';
import type { ChannelDef } from '~/_api/definitions.ts';
import type { Primitive } from '~/primitive.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';

/**
 * The rate-limit inputs `assemble(...)` collects: per-scope/per-event handler
 * overrides, plus the channel-level rule each channel scope declares. The
 * top-level rule comes from the capability itself, so it is not passed here.
 *
 * @internal
 */
export interface RateLimitBuildInput {
  /** Per-handler overrides, keyed by scope (`'top'` or `'channel:<key>'`) then event. */
  readonly overrides: ReadonlyMap<string, ReadonlyMap<string, RateLimitConfig>>;
  /** Channel-level rules, keyed by channel key — the scope default for that channel. */
  readonly channelRules: ReadonlyMap<string, RateLimitConfig>;
}

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
  /** Host-owned: rejected inside a plugin's `define({ scoped: true })`. @internal */
  readonly __hostOnly: true;
  /** The global rule, or `undefined` when only per-handler limits apply. @internal */
  readonly __rateLimit: RateLimitConfig | undefined;
  /**
   * Build the rate-limit intercept from the global rule plus the channel rules
   * and per-handler overrides collected at assembly, or `null` when nothing
   * limits anything. Kept on the capability so the core never imports the
   * rate-limit engine.
   * @internal
   */
  readonly __buildRateLimit: (input: RateLimitBuildInput) => Primitive | null;
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
export const rateLimit = withCapabilityKind(function rateLimit(
  config?: RateLimitGlobalConfig,
): RateLimitCapability {
  const rule: RateLimitConfig | undefined = config ? { enabled: true, ...config } : undefined;
  const cap = capability<{}>([]) as RateLimitCapability;
  const writable = cap as {
    __hostOnly: true;
    __rateLimit: RateLimitConfig | undefined;
    __buildRateLimit: (input: RateLimitBuildInput) => Primitive | null;
  };
  writable.__hostOnly = true;
  writable.__rateLimit = rule;
  writable.__buildRateLimit = ({ overrides, channelRules }) => {
    // Each channel rule becomes a synthetic top-level channel definition so the
    // cascade resolver produces a `channel:<key>` scope rule for it.
    const definitions: ChannelDef[] = [];
    for (const [key, cfg] of channelRules) {
      definitions.push({ _: 'channel', pattern: key, rateLimit: cfg, definitions: [] });
    }
    const plan = resolvePlan({ contractRateLimit: rule, definitions, overrides });
    return plan ? rateLimitFactory(plan) : null;
  };
  return stampKind(cap, CAPABILITY_KIND.rateLimit);
}, CAPABILITY_KIND.rateLimit);
