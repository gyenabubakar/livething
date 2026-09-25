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

/**
 * Throw at declaration time if a declared name contains `::`. LiveThing uses
 * `::` to join a plugin id to its names (`__<id>::<name>`), so a name that
 * already contains it could be split in the wrong place.
 */
export function assertNoNameSeparator(name: string, kind: string): void {
  if (!name.includes('::')) return;

  throw new Error(
    `[livething] ${kind} '${name}' contains '::', which is reserved as the separator in ` +
      `plugin names ('__<id>::<name>') — pick a different name.`,
  );
}
