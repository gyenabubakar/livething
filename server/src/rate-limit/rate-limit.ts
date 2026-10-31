/* oxlint-disable @typescript-eslint/no-explicit-any */
import { RateLimited } from '@livething/core';
import { intercept } from '~/intercept/intercept.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { Primitive } from '~/primitive.ts';
import { connectionBudgetKey, RateLimitRuntime } from './runtime.ts';
import type { ResolvedRateLimitPlan } from './runtime.ts';

/**
 * One rate-limit rule. Same shape at every level so cascade works by partial
 * override: a channel's `{ max: 200 }` keeps the parent's `windowMs` and `per`.
 */
interface RateLimitRule {
  /** Length of the rolling window, in milliseconds. Default: `60_000` (one minute). */
  readonly windowMs?: number;
  /** Maximum events per window. Default: `60`. */
  readonly max?: number;
  /**
   * Pick the bucket key from the connection context. Default: `ctx.connection.id`
   * (per-connection). Use `(ctx) => ctx.user.id` to share a single budget
   * across every socket the user has open. An empty key falls back to the
   * connection's own budget, so anonymous connections never share one bucket.
   */
  readonly per?: (ctx: any) => string;
}

/**
 * The `rateLimit` field on a channel or handler config. An object turns
 * limiting on with that rule; `false` turns it off for that channel or handler.
 */
export type RateLimitConfig = false | RateLimitRule;

export const RATE_LIMIT_DEFAULTS = Object.freeze({
  windowMs: 60_000,
  max: 60,
  per: connectionBudgetKey,
});

export interface RateLimitPrimitive extends Primitive<'intercept'> {}

/**
 * Build the rate-limit primitive from a resolved cascade plan. The primitive
 * runs as an intercept: it fires before validation and before the handler,
 * so a rejected frame never reaches user code.
 *
 * On rejection it throws `RateLimited({ retryAfterMs })`, which the engine
 * routes to an `__error__` frame while preserving the request's
 * `metadata.exchange.id` when present.
 *
 * Use the `rateLimit({...})` capability for the server-wide rule, plus the
 * optional `rateLimit` field on a `base.on(...)` / `base.request(...)` config or
 * a `base.channel(...)` config to tighten, loosen, or disable it per handler or
 * channel. The `assemble(...)` step calls this factory; you should not normally
 * call it directly.
 */
export function rateLimit(plan: ResolvedRateLimitPlan): RateLimitPrimitive {
  const runtime = new RateLimitRuntime(plan);
  const primitive = intercept((ctx, message) => {
    const verdict = runtime.check(ctx, message.event);
    if (verdict) throw RateLimited({ retryAfterMs: verdict.retryAfterMs });
  });
  return {
    ...primitive,
    __chargedOnArrival: true,
    __setup(engine: EngineAccess) {
      engine.onConnectionCleanup((connectionId) => runtime.forgetConnection(connectionId));
    },
  } as unknown as RateLimitPrimitive;
}
