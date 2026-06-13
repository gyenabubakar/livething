/* oxlint-disable @typescript-eslint/no-explicit-any */

// `matches` and `unsafeCast` are standalone functions (not methods on the
// contract) because method variance with `this`-typed return positions breaks
// the contract's assignability to `Contract<unknown, unknown>`. Top-level
// generics work cleanly with type predicates.

import { validateValue } from '~/_engine/compile/utils.ts';
import type { InterceptFrame } from '~/intercept/intercept.ts';
import type { Contract } from './contract-types.ts';
import type { Definition } from './definitions.ts';
import type { FrameFor, ParsedKey } from './matches-types.ts';

/** Parse a path key. Throws on syntactically invalid keys. */
export function parseKey(key: string): ParsedKey {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`[wskit] contract.matches/unsafeCast key must be a non-empty string`);
  }

  if (key.startsWith('@')) {
    const rest = key.slice(1);
    const sepIdx = rest.indexOf('::');
    if (sepIdx === -1) {
      throw new Error(
        `[wskit] contract.matches/unsafeCast key '${key}' starts with '@' but is missing the ` +
          `'::' separator. Use '@<channel>::<event>'.`,
      );
    }
    const name = rest.slice(0, sepIdx);
    const event = rest.slice(sepIdx + 2);
    if (name.length === 0 || event.length === 0) {
      throw new Error(
        `[wskit] contract.matches/unsafeCast key '${key}' has an empty name or event.`,
      );
    }
    return { scope: 'channel', name, event };
  }

  if (key.includes('::')) {
    throw new Error(
      `[wskit] contract.matches/unsafeCast key '${key}' contains '::' but no scope prefix. ` +
        `Use '@<channel>::<event>', or drop the '::' for a top-level event.`,
    );
  }

  return { scope: 'top', event: key };
}

interface EventLookup {
  readonly validator: unknown;
  readonly kind: 'incoming' | 'request' | 'stream';
}

/** Walk a definitions list and find the matching event's validator + kind. */
function lookupEvent(
  definitions: readonly Definition[],
  eventName: string,
): EventLookup | undefined {
  for (const def of definitions) {
    if (def._ === 'incoming' && def.name === eventName) {
      return { validator: def.schema, kind: 'incoming' };
    }
    if (def._ === 'request' && def.name === eventName) {
      return { validator: def.payload, kind: 'request' };
    }
    if (def._ === 'stream' && def.name === eventName) {
      return { validator: def.payload, kind: 'stream' };
    }
    if (def._ === 'resumable-stream' && def.name === eventName) {
      return { validator: def.payload, kind: 'stream' };
    }
    if (def._ === 'recorded-stream' && def.name === eventName) {
      return { validator: def.payload, kind: 'stream' };
    }
  }
  return undefined;
}

/** Find the event definition for a parsed key. Returns undefined if no scope/event match. */
function lookupForParsedKey(
  contractDefinitions: readonly Definition[],
  parsed: ParsedKey,
): EventLookup | undefined {
  if (parsed.scope === 'top') {
    return lookupEvent(contractDefinitions, parsed.event);
  }

  for (const def of contractDefinitions) {
    if (def._ !== 'channel') continue;
    const channelKey =
      typeof def.pattern === 'string' ? def.pattern : (def.pattern as { key: string }).key;
    if (channelKey !== parsed.name) continue;
    return lookupEvent(def.definitions, parsed.event);
  }
  return undefined;
}

/**
 * Runtime check + type narrowing: returns `true` when `frame.event`,
 * `frame.routing` scope, and `frame.payload` all match the key. The payload
 * is run through the declared validator.
 *
 * Use inside an intercept to narrow a generic frame to a typed shape:
 *
 * ```ts
 * intercept((ctx, frame) => {
 *   if (matches(myContract, '@chat::send-message', frame)) {
 *     frame.payload; // narrowed AND validated
 *   }
 * });
 * ```
 *
 * Throws when the key references a scope/event the contract doesn't declare
 * — that's a bug in the caller, not a runtime mismatch.
 */
export function matches<TContract extends Contract<any, any>, TKey extends string>(
  contract: TContract,
  key: TKey,
  frame: InterceptFrame,
): frame is FrameFor<TContract, TKey> {
  const parsed = parseKey(key);

  // Validate the key against the contract first — a typo here is a bug in
  // the caller's code, not a runtime mismatch, and should surface loudly
  // before the routing/payload checks short-circuit to a silent `false`.
  const lookup = lookupForParsedKey(contract.definitions as readonly Definition[], parsed);
  if (!lookup) {
    throw new Error(
      `[wskit] matches: key '${key}' references an event the contract does not declare. ` +
        `Check the scope name and event name.`,
    );
  }

  if (frame.event !== parsed.event) return false;

  if (parsed.scope === 'top') {
    if (frame.routing.channel !== undefined) return false;
  } else if (parsed.scope === 'channel') {
    const channelDef = (contract.definitions as readonly Definition[]).find(
      (def): def is Extract<Definition, { _: 'channel' }> =>
        def._ === 'channel' &&
        (typeof def.pattern === 'string' ? def.pattern : def.pattern.key) === parsed.name,
    );
    if (!channelDef) return false;

    if (typeof channelDef.pattern === 'string') {
      if (frame.routing.channel !== parsed.name) return false;
    } else {
      if (frame.routing.channelScope !== parsed.name) return false;
      if (typeof frame.routing.channel !== 'string') return false;
      if (!channelDef.pattern.pattern.test(frame.routing.channel)) return false;
    }
  }

  try {
    validateValue(lookup.validator, frame.payload, parsed.event);
    return true;
  } catch {
    return false;
  }
}

/**
 * Type-only assertion: returns the frame with the narrowed `FrameFor` shape.
 * No runtime check is performed — call this only when your own logic has
 * already established the kind/scope/payload validity.
 *
 * Throws on unknown keys to catch typos that would otherwise live silently.
 */
export function unsafeCast<TContract extends Contract<any, any>, TKey extends string>(
  contract: TContract,
  key: TKey,
  frame: InterceptFrame,
): FrameFor<TContract, TKey> {
  const parsed = parseKey(key);
  const lookup = lookupForParsedKey(contract.definitions as readonly Definition[], parsed);
  if (!lookup) {
    throw new Error(
      `[wskit] unsafeCast: key '${key}' references an event the contract does not declare. ` +
        `Check the scope name and event name.`,
    );
  }
  return frame as FrameFor<TContract, TKey>;
}
