import { assertValidLiveThingIdentifier } from '@livething/core';

/**
 * Throw at declaration time if an event name clashes with the LiveThing wire
 * protocol. `ping`/`pong` are raw keepalive frames; the `__` prefix/suffix is
 * reserved for protocol events and plugin-owned wire names.
 */
export function assertNonReservedEventName(name: string, factory: string): void {
  assertValidLiveThingIdentifier(name, `${factory}() event name`);
  if (name === 'ping' || name === 'pong') {
    throw new Error(
      `[livething] '${name}' is a reserved keepalive frame name. Pick a different name for ${factory}().`,
    );
  }
}
