import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { frameMatches, frameUnsafeCast } from '~/intercept/frame-match.ts';
import { runIntercepts } from '~/intercept/runtime.ts';
import { definePrimitive } from '~/primitive.ts';
import type { Capability } from '~/_define/capability.ts';
import type { EngineAccess } from '~/_engine/access.ts';

const INTERCEPT_RUNTIME_KEY = Symbol('intercept-runtime');

/**
 * Wire the intercept pipeline runner and the `ctx.matches` / `ctx.unsafeCast`
 * frame matchers into the engine, so the dispatch hub and connection context can
 * reach them without importing the intercept runtime. Shared by the
 * `intercepts()` capability and by `rateLimit()`, which runs as an intercept;
 * `installOnce` keeps it set a single time.
 */
export function registerInterceptRuntime(engine: EngineAccess): void {
  engine.installOnce(INTERCEPT_RUNTIME_KEY, () => {
    engine.setInterceptRuntime(runIntercepts, {
      matches: frameMatches,
      unsafeCast: frameUnsafeCast,
    });
  });
}

const interceptRuntimePrimitive = definePrimitive({
  tag: 'intercept-runtime',
  key: Symbol('intercept-runtime-primitive'),
  kind: 'infrastructure',
  create: () => ({}),
  setup(engine) {
    registerInterceptRuntime(engine);
  },
});

/**
 * Enable frame interception. Listing this grants `base.intercept(...)` (and
 * channel `intercept(...)`), plus `ctx.matches(...)` / `ctx.unsafeCast(...)` for
 * narrowing a frame's payload. An intercept sees every incoming frame before it
 * is routed and may replace the payload or throw `Block` / `Disconnect`.
 *
 * @example
 * ```ts
 * import { define, t } from '@wskit/server';
 * import { intercepts } from '@wskit/server/intercepts';
 *
 * const base = define({ env: t<Env>(), capabilities: [intercepts()] });
 *
 * base.intercept((ctx, frame) => {
 *   if (frame.kind === 'incoming') console.log(frame.event);
 * });
 * ```
 */
export const intercepts = withCapabilityKind(function intercepts(): Capability<
  {},
  never,
  'intercepts'
> {
  return stampKind(
    capability<{}, never, 'intercepts'>([interceptRuntimePrimitive()]),
    CAPABILITY_KIND.intercepts,
  );
}, CAPABILITY_KIND.intercepts);
