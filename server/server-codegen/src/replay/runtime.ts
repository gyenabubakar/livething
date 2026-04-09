import { ENGINE_SCOPE_META } from '~/_engine/contexts/types.ts';
import type { EngineScopeMeta } from '~/_engine/contexts/types.ts';

/**
 * Decide whether one replay primitive instance owns the current replay request.
 *
 * Top-level replay handles only top-level requests. Channel replay handles only
 * requests for its own concrete channel or channel-family key.
 */
export function matchesReplayScope(
  channelKey: string | undefined,
  scope: { namespaceName?: string; channelName?: string; channelScope?: string },
): boolean {
  if (channelKey) {
    return scope.channelScope === channelKey || scope.channelName === channelKey;
  }

  return !scope.namespaceName && !scope.channelName && !scope.channelScope;
}

/**
 * Read the hidden engine scope markers attached to one live connection ctx.
 */
export function readReplayContextScope(ctx: Record<PropertyKey, unknown>): EngineScopeMeta {
  return (ctx[ENGINE_SCOPE_META] as EngineScopeMeta | undefined) ?? {};
}
