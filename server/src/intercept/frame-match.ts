import { validateValue } from '~/_engine/compile/utils.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type { InterceptFrame } from './intercept.ts';

/** A parsed `ctx.matches` / `ctx.unsafeCast` key. */
type ParsedKey =
  | { readonly scope: 'top'; readonly event: string }
  | { readonly scope: 'channel'; readonly name: string; readonly event: string };

/** Parse a frame-match key. Throws on a syntactically invalid key. */
function parseKey(key: string): ParsedKey {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('[wskit] ctx.matches/unsafeCast key must be a non-empty string');
  }

  if (key.startsWith('@')) {
    const rest = key.slice(1);
    const sepIdx = rest.indexOf('::');
    if (sepIdx === -1) {
      throw new Error(
        `[wskit] ctx.matches/unsafeCast key '${key}' starts with '@' but is missing the ` +
          `'::' separator. Use '@<family>::<event>'.`,
      );
    }
    const name = rest.slice(0, sepIdx);
    const event = rest.slice(sepIdx + 2);
    if (name.length === 0 || event.length === 0) {
      throw new Error(`[wskit] ctx.matches/unsafeCast key '${key}' has an empty name or event.`);
    }
    return { scope: 'channel', name, event };
  }

  if (key.includes('::')) {
    throw new Error(
      `[wskit] ctx.matches/unsafeCast key '${key}' contains '::' but no scope prefix. ` +
        `Use '@<family>::<event>', or drop the '::' for a top-level event.`,
    );
  }

  return { scope: 'top', event: key };
}

/** The validator an event declares, in either the top scope or one channel. */
function lookupValidator(
  source: Pick<
    EngineCompileTypes.CompiledServer,
    'incoming' | 'requests' | 'streams' | 'resumableStreams' | 'recordedStreams'
  >,
  event: string,
): { found: boolean; validator: unknown } {
  const primitive =
    source.incoming.get(event) ??
    source.requests.get(event) ??
    source.streams.get(event) ??
    source.resumableStreams.get(event) ??
    source.recordedStreams.get(event);
  if (!primitive) return { found: false, validator: undefined };
  const validator =
    'stream' in primitive
      ? primitive.stream.validator
      : (primitive as { validator?: unknown }).validator;
  return { found: true, validator };
}

/** Resolve a parsed key against the catalog. Throws when the key names no declared event. */
function resolveKey(
  compiled: EngineCompileTypes.CompiledServer,
  key: string,
  parsed: ParsedKey,
): { validator: unknown; channel?: EngineCompileTypes.CompiledChannel } {
  if (parsed.scope === 'top') {
    const lookup = lookupValidator(compiled, parsed.event);
    if (!lookup.found) {
      throw new Error(
        `[wskit] ctx.matches/unsafeCast: key '${key}' references an event the server does not ` +
          `declare. Check the event name.`,
      );
    }
    return { validator: lookup.validator };
  }

  const channel = compiled.channels.get(parsed.name) ?? compiled.channelFamilies.get(parsed.name);
  if (!channel) {
    throw new Error(
      `[wskit] ctx.matches/unsafeCast: key '${key}' references channel '${parsed.name}' which the ` +
        `server does not declare.`,
    );
  }
  const lookup = lookupValidator(channel, parsed.event);
  if (!lookup.found) {
    throw new Error(
      `[wskit] ctx.matches/unsafeCast: key '${key}' references an event channel '${parsed.name}' ` +
        `does not declare.`,
    );
  }
  return { validator: lookup.validator, channel };
}

/** Whether a frame's routing matches a parsed key's scope (and the channel pattern, for dynamic). */
function routingMatches(
  parsed: ParsedKey,
  channel: EngineCompileTypes.CompiledChannel | undefined,
  frame: InterceptFrame,
): boolean {
  if (parsed.scope === 'top') return frame.routing.channel === undefined;
  if (!channel) return false;
  if (typeof channel.pattern === 'string') {
    return frame.routing.channel === parsed.name;
  }
  if (frame.routing.channelFamily !== parsed.name) return false;
  if (typeof frame.routing.channel !== 'string') return false;
  return ChannelPrimitive.matchesFamilyPattern(channel.pattern, frame.routing.channel);
}

/**
 * Runtime body for `ctx.matches(key, frame)`. Returns `true` when the frame's
 * event, scope, and payload all match the key — the payload is run through the
 * declared validator. Throws when the key names no declared event.
 */
export function frameMatches(
  compiled: EngineCompileTypes.CompiledServer,
  key: string,
  frame: InterceptFrame,
): boolean {
  const parsed = parseKey(key);
  const { validator, channel } = resolveKey(compiled, key, parsed);
  if (frame.event !== parsed.event) return false;
  if (!routingMatches(parsed, channel, frame)) return false;
  try {
    validateValue(validator, frame.payload, parsed.event);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runtime body for `ctx.unsafeCast(key, frame)`. Validates the key against the
 * catalog (throws on an unknown key) but performs no runtime payload check —
 * it returns the frame unchanged for the caller to treat as narrowed.
 */
export function frameUnsafeCast(
  compiled: EngineCompileTypes.CompiledServer,
  key: string,
  frame: InterceptFrame,
): InterceptFrame {
  const parsed = parseKey(key);
  resolveKey(compiled, key, parsed);
  return frame;
}
