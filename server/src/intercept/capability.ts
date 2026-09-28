import { CAPABILITY_KIND } from '~/_define/capability-kinds.ts';
import { capability, stampKind, withCapabilityKind } from '~/_define/capability.ts';
import { runIntercepts } from '~/intercept/runtime.ts';
import { definePrimitive } from '~/primitive.ts';
import type { Capability } from '~/_define/capability.ts';
import type { EngineAccess } from '~/_engine/access.ts';

const INTERCEPT_RUNTIME_KEY = Symbol('intercept-runtime');

/**
 * Wire the intercept pipeline runner into the engine, so the dispatch hub can
 * reach it without importing the intercept runtime. Shared by the `intercepts()`
 * capability and by `rateLimit()`, which runs as an intercept; `installOnce`
 * keeps it set a single time. The `ctx.matches` / `ctx.unsafeCast` matchers are
 * core and always present, so they are not registered here.
 */
export function registerInterceptRuntime(engine: EngineAccess): void {
  engine.installOnce(INTERCEPT_RUNTIME_KEY, () => {
    engine.setInterceptRuntime(runIntercepts);
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
 * channel `intercept(...)`). An intercept sees every incoming frame before it
 * is routed and may replace the payload or throw `Block` / `Disconnect`. The
 * `ctx.matches(...)` / `ctx.unsafeCast(...)` frame matchers are core and work
 * without this capability.
 *
 * @example
 * ```ts
 * import { server, t } from '@livething/server';
 * import { intercepts } from '@livething/server/intercepts';
 *
 * const base = server({ capabilities: [intercepts()] });
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
