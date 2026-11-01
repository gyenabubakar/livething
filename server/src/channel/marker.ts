import type { Primitive } from '~/primitive.ts';

/** The TypeScript type returned by `membershipMarker(durable)`. */
export interface MembershipMarkerPrimitive extends Primitive<'membership-marker'> {
  /** Whether the channel opts into durable membership. */
  readonly durable: boolean;
}

/** @internal */
const MEMBERSHIP_MARKER_KEY = Symbol('membership-marker');

/**
 * Channel-scope marker that records the dev's per-channel `membership` choice
 * on the engine. The engine reads this back per channel-key at runtime to
 * decide whether to write a durable membership row on subscribe and whether to
 * drop the row on disconnect. A channel with no explicit choice is ephemeral
 * by default; this marker only exists for a channel that states one.
 *
 * @internal
 */
export function membershipMarker(durable: boolean): MembershipMarkerPrimitive {
  return {
    __livething: 'membership-marker',
    __identity: [MEMBERSHIP_MARKER_KEY],
    __requires: {},
    durable,
    __setup(engine) {
      const scope = engine.getScopeInfo();
      if (!scope.channelKey) return;

      engine.setChannelDurable(scope.channelKey, durable);
    },
  };
}
