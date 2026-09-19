import { createEngineAccess } from '~/_engine/registry/engine-access.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { EngineAccessDeps } from '~/_engine/registry/engine-access.ts';
import type * as PrimitiveCore from '~/primitive.ts';

type VisitScopeParameter = { channelKey?: string };

type Primitive = PrimitiveCore.Primitive;

/**
 * Walk the primitive tree and let each primitive register its runtime hooks.
 * Scope is threaded through so channel-scoped hooks know their channel key.
 */
export function installPrimitiveHooks(core: EngineCore, deps: EngineAccessDeps): void {
  function visit(primitives: readonly Primitive[], scope?: VisitScopeParameter) {
    for (const primitive of primitives) {
      primitive.__setup?.(createEngineAccess(core, deps, scope));

      if (primitive.__livething === 'channel') {
        const channelPrimitive = primitive as Primitive & {
          pattern: string | { key: string };
          primitives: readonly Primitive[];
        };
        visit(channelPrimitive.primitives, {
          channelKey:
            typeof channelPrimitive.pattern === 'string'
              ? channelPrimitive.pattern
              : channelPrimitive.pattern.key,
        });
      }
    }
  }

  visit(core.primitives);
}
