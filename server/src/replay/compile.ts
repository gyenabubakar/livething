/* oxlint-disable @typescript-eslint/no-explicit-any */
import type { Primitive } from '~/primitive.ts';

/**
 * Walk the primitive tree and record every channel key that has its own
 * `.replay(...)` (configured or `replay(false)` disabled). Server-level
 * replay uses the resulting set to skip channels that opted out of cascade.
 *
 * Groups merge into the parent scope, so we descend into them with the
 * parent channel key.
 */
export function collectReplayClaimedScopes(
  primitives: readonly Primitive[],
  out: Set<string>,
  parentChannelKey?: string,
): void {
  for (const primitive of primitives) {
    if (primitive.__livething === 'replay') {
      if (parentChannelKey) out.add(parentChannelKey);
      continue;
    }

    if (primitive.__livething === 'group') {
      const group = primitive as Primitive & { primitives: readonly Primitive[] };
      collectReplayClaimedScopes(group.primitives, out, parentChannelKey);
      continue;
    }

    if (primitive.__livething === 'channel') {
      const channelPrimitive = primitive as Primitive & {
        pattern: string | { key: string };
        primitives: readonly Primitive[];
      };
      const channelKey =
        typeof channelPrimitive.pattern === 'string'
          ? channelPrimitive.pattern
          : channelPrimitive.pattern.key;
      collectReplayClaimedScopes(channelPrimitive.primitives, out, channelKey);
      continue;
    }
  }
}
