import type { Primitive } from '~/primitive.ts';

/** The TypeScript type returned by `persistentMarker(enabled)`. */
export interface PersistentMarkerPrimitive extends Primitive<'persistent-marker'> {
  /** Whether the channel opts into persistence. `false` is the only useful value today. */
  readonly enabled: boolean;
}

/** @internal */
const PERSISTENT_MARKER_KEY = Symbol('persistent-marker');

/**
 * Channel-scope marker that records the dev's per-channel `persistent` choice
 * on the engine. The engine reads this back per channel-key at runtime to
 * decide whether to write a durable membership row on subscribe and whether to
 * drop the row on disconnect.
 *
 * On a persistence-disabled server (no `persistence: true`) the marker is a
 * pure no-op — the engine never consults the registry because every channel
 * stays ephemeral regardless.
 *
 * @internal
 */
export function persistentMarker(enabled: boolean): PersistentMarkerPrimitive {
  return {
    __wskit: 'persistent-marker',
    __kind: 'infrastructure',
    __identity: [PERSISTENT_MARKER_KEY],
    __requires: {},
    enabled,
    __setup(engine) {
      const scope = engine.getScopeInfo();
      if (!scope.channelKey) return;
      engine.setChannelPersistent(scope.channelKey, enabled);
    },
  };
}

persistentMarker.__key = PERSISTENT_MARKER_KEY;
