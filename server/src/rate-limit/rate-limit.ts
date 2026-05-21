/* oxlint-disable @typescript-eslint/no-explicit-any */
import { RateLimited } from '@wskit/core';
import { intercept } from '~/intercept/intercept.ts';
import type { Primitive } from '~/primitive.ts';
import { RateLimitRuntime } from './runtime.ts';
import type { ResolvedRateLimitPlan } from './runtime.ts';

/**
 * Public configuration shape for `rateLimit:` on the contract, channels, and
 * namespaces, and for the per-handler `.rateLimit(event, config)` override.
 *
 * Same shape at every level so cascade works by partial override:
 * a channel's `{ max: 200 }` keeps the parent's `windowMs` and `per`.
 */
export interface RateLimitConfig {
  /** Switch the rule on or off at this scope/event. `false` disables and stops cascade. */
  readonly enabled: boolean;
  /** Length of the rolling window, in milliseconds. Default: `60_000` (one minute). */
  readonly windowMs?: number;
  /** Maximum events per window. Default: `60`. */
  readonly max?: number;
  /**
   * Pick the bucket key from the connection context. Default: `ctx.id`
   * (per-connection). Use `(ctx) => ctx.identity` to share a single budget
   * across every socket the user has open.
   */
  readonly per?: (ctx: any) => string;
}

export const RATE_LIMIT_DEFAULTS = Object.freeze({
  windowMs: 60_000,
  max: 60,
  per: (ctx: any) => String(ctx?.id ?? ''),
});

export interface RateLimitPrimitive extends Primitive<'intercept'> {}

/** @internal */
const RATE_LIMIT_KEY = Symbol('rate-limit');

/**
 * Build the rate-limit primitive from a resolved cascade plan. The primitive
 * runs as a pre-intercept: it fires before validation and before the handler,
 * so a rejected frame never reaches user code.
 *
 * On rejection it throws `RateLimited({ retryAfter })` which the engine
 * routes to an `__error__` frame, preserving `__wskit.correlationId` / `__wskit.ackId` if the
 * original frame carried them.
 *
 * Use through the `rateLimit:` config on `contract({...})`, `channel({...})`,
 * or `namespace({...})` — or `.rateLimit(event, config)` on the
 * implementer / channel sub-builder / namespace sub-builder. The
 * `implement(...)` build step calls this factory; you should not normally
 * call it directly.
 */
export function rateLimit(plan: ResolvedRateLimitPlan): RateLimitPrimitive {
  const runtime = new RateLimitRuntime(plan);
  const primitive = intercept((ctx, message) => {
    const verdict = runtime.check(ctx, message.event);
    if (verdict) throw RateLimited({ retryAfter: verdict.retryAfter });
  }) as unknown as RateLimitPrimitive;
  return primitive;
}

rateLimit.__key = RATE_LIMIT_KEY;
