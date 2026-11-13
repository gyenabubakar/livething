/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { resolvePlan } from '~/rate-limit/plan.ts';
import { rateLimit as rateLimitFactory } from '~/rate-limit/rate-limit.ts';
import type { Capability } from '~/_define/capability.ts';
import type { Primitive } from '~/primitive.ts';
import type { RateLimitConfig } from '~/rate-limit/rate-limit.ts';

/**
 * The rate-limit inputs `assemble(...)` collects: per-scope/per-event handler
 * overrides, plus the channel-level rule each channel scope declares. The
 * top-level rule comes from the capability itself, so it is not passed here.
 *
 * @internal
 */
interface RateLimitBuildInput {
  /** Per-handler overrides, keyed by scope (`'top'` or `'channel:<key>'`) then event. */
  readonly overrides: ReadonlyMap<string, ReadonlyMap<string, RateLimitConfig>>;
  /** Channel-level rules, keyed by channel key — the scope default for that channel. */
  readonly channelRules: ReadonlyMap<string, RateLimitConfig>;
  /**
   * Every channel key in the app, including channels with no own rule. A channel
   * with no rule still needs a scope entry so its events inherit the top-level
   * cap (shared bucket) instead of passing through unlimited.
   */
  readonly channelKeys?: ReadonlySet<string>;
}

/**
 * The global rate-limit rule. It applies to every event unless a per-handler
 * `rateLimit` override replaces it. Omit it to enable rate limiting with no
 * global default — useful when only a few handlers set their own limit.
 */
export interface RateLimitGlobalConfig {
  /** Length of the rolling window, in milliseconds. Defaults to 60000. */
  readonly windowMs?: number;
  /** Maximum messages allowed per window. Defaults to 60. */
  readonly maxMessages?: number;
  /**
   * Maximum bytes allowed per window, counted on the whole frame (UTF-8 for text). No byte
   * limit by default. A frame bigger than this passes only when the budget is full, and it
   * empties it.
   */
  readonly maxBytes?: number;
  /**
   * Pick the budget key from the connection. Defaults to one budget per
   * connection; return `ctx.user.id` to share one budget across a user's
   * sockets. An empty key falls back to the connection's own budget, so
   * anonymous connections never share one bucket.
   */
  readonly per?: (ctx: any) => string;
}

/** A `rateLimit(...)` capability, carrying its global rule and intercept builder for assembly. */
export interface RateLimitCapability extends Capability<
  {},
  never,
  'rateLimit',
  typeof CAPABILITY_KIND.rateLimit
> {
  /** Host-owned: rejected inside a plugin's `server({ scope: 'plugin' })`. @internal */
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
 * event shares (`rateLimit({ windowMs, maxMessages, maxBytes })`), or with no argument to enable
 * rate limiting without a global default so only handlers that set their own
 * `rateLimit` override are limited. A handler override can raise, lower, or
 * disable the limit for one event.
 *
 * Listing this capability is required to use any rate limit, including a
 * per-handler override.
 *
 * @example
 * ```ts
 * import { server, t } from '@livething/server';
 * import { rateLimit } from '@livething/server/rate-limit';
 *
 * const base = server({
 *   capabilities: [rateLimit({ windowMs: 60_000, maxMessages: 100 })],
 * });
 * ```
 */
export const rateLimit = withCapabilityKind(function rateLimit(
  config?: RateLimitGlobalConfig,
): RateLimitCapability {
  const rule: RateLimitConfig | undefined = config ? { ...config } : undefined;
  const cap = capability<{}, never, 'rateLimit', typeof CAPABILITY_KIND.rateLimit>(
    [],
  ) as RateLimitCapability;
  const writable = cap as {
    __hostOnly: true;
    __rateLimit: RateLimitConfig | undefined;
    __buildRateLimit: (input: RateLimitBuildInput) => Primitive | null;
  };
  writable.__hostOnly = true;
  writable.__rateLimit = rule;

  writable.__buildRateLimit = (input) => {
    const { overrides, channelRules, channelKeys } = input;
    // Every channel gets a `channel:<key>` scope. A channel with no own rule
    // inherits the top-level rule — a shared bucket.
    const keys = new Set<string>([...channelRules.keys(), ...(channelKeys ?? [])]);
    const channels = [...keys].map((key) => ({ key, rateLimit: channelRules.get(key) }));

    const plan = resolvePlan({ contractRateLimit: rule, channels, overrides });

    return plan ? rateLimitFactory(plan) : null;
  };

  return stampKind(cap, CAPABILITY_KIND.rateLimit);
}, CAPABILITY_KIND.rateLimit);
