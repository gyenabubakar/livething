import { assertValidWSKitIdentifier } from '@wskit/core';

/**
 * Throw at declaration time if an event name clashes with the WSKit wire
 * protocol. `ping`/`pong` are raw keepalive frames; the `__` prefix/suffix is
 * reserved for protocol events and plugin-owned wire names.
 */
export function assertNonReservedEventName(name: string, factory: string): void {
  assertValidWSKitIdentifier(name, `${factory}() event name`);
  if (name === 'ping' || name === 'pong') {
    throw new Error(
      `[wskit] '${name}' is a reserved keepalive frame name. Pick a different name for ${factory}().`,
    );
  }
}
