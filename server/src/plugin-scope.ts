/* oxlint-disable @typescript-eslint/no-explicit-any */
import { WSKitError } from '@wskit/core';
import { PRIVILEGED_KV } from '~/_engine/contexts/lazy-storage.ts';
import type { FrameOwner } from '~/intercept/intercept.ts';

/**
 * The delimiter between a plugin id and a short name on the wire. A plugin's
 * event `heartbeat` under plugin `acme:presence` travels as
 * `__acme:presence::heartbeat`. `::` is framework-reserved (it also marks
 * the channel in addressing), so it can never appear in a user-declared name —
 * which makes the id↔name split unambiguous (split once on `::`).
 */
const PLUGIN_NS_DELIM = '::';

/** Build the wire name for a plugin-owned event: `__<id>::<name>`. */
export function pluginWireName(id: string, name: string): string {
  return `__${id}${PLUGIN_NS_DELIM}${name}`;
}

/**
 * Split a plugin wire name back into its `{ id, name }`. Returns `null` for any
 * event that is not plugin-owned — i.e. one not shaped `__<id>::<name>`.
 */
export function parsePluginWireName(event: string): { id: string; name: string } | null {
  if (!event.startsWith('__')) return null;

  const delimAt = event.indexOf(PLUGIN_NS_DELIM);
  if (delimAt < 0) return null;

  const id = event.slice(2, delimAt);
  const name = event.slice(delimAt + PLUGIN_NS_DELIM.length);
  if (!id || !name) return null;

  return { id, name };
}

/**
 * Derive a frame's owner from its event name: a `__<id>::<name>` event is
 * owned by plugin `<id>`, everything else is the app's.
 */
export function frameOwner(event: string): FrameOwner {
  const parsed = parsePluginWireName(event);
  return parsed ? { kind: 'plugin', id: parsed.id } : { kind: 'app' };
}

/** The tag-kind readers a plugin scope rewrites so a group name resolves namespaced. */
const TAG_KINDS = new Set(['ephemeral', 'persistent']);

/** The send-like context methods whose event argument a plugin scope rewrites. */
type SendPosition = 'event-first' | 'event-second';
const SCOPED_SENDS: Record<string, SendPosition> = {
  send: 'event-first',
  broadcast: 'event-first',
  // request/broadcastRequest/sendWithAck all take the event/request name first,
  // so a plugin's `ctx.request('confirm', ...)` goes out as `__<id>::confirm`
  // to match its namespaced `requests({...})` declaration.
  request: 'event-first',
  broadcastRequest: 'event-first',
  // sendReplay re-sends a stored message by event name; namespace it so a
  // plugin's replayed frame matches its own namespaced declaration.
  sendReplay: 'event-first',
};

/** The methods on a `ctx.connection(ref)` handle whose first arg is the event name. */
const SCOPED_CONNECTION_METHODS = new Set(['send', 'request']);

/** The methods on a `ctx.channel` handle whose first arg is the channel event name. */
const SCOPED_CHANNEL_SENDS = new Set([
  'send',
  'broadcast',
  'request',
  'broadcastRequest',
  'sendReplay',
]);

/** The KV methods whose key/prefix argument a plugin scope namespaces. */
const SCOPED_KV_KEYS = new Set(['get', 'set', 'delete', 'list']);

/**
 * Wrap a handler context so its send-like methods prefix the event name with
 * the plugin's namespace. A plugin handler (or its `api`) writes
 * `ctx.send('user-online', ...)` and the client receives `__<id>::user-online`,
 * matching the namespaced `emits(...)` declaration.
 */
export function scopePluginContext(id: string, ctx: any): any {
  let tagsProxy: unknown;
  let kvProxy: unknown;
  return new Proxy(ctx as Record<PropertyKey, unknown>, {
    get(target, key, receiver) {
      // `ctx.schedule('task')` / `ctx.cancelScheduled('task')` — the task id is
      // namespaced like an event so a plugin's `schedule(...)` reaches its own
      // namespaced task primitive.
      if (key === 'schedule' || key === 'cancelScheduled') {
        const original = Reflect.get(target, key, receiver) as (...args: unknown[]) => unknown;
        if (typeof original !== 'function') return original;
        return (task: unknown, ...rest: unknown[]) =>
          original(pluginWireName(id, task as string), ...rest);
      }

      // `ctx.connection(ref).send/request/sendWithAck('evt', ...)` — the handle
      // is built fresh per call, so wrap each event-first method to namespace the
      // event like a plain `ctx.send`.
      if (key === 'connection') {
        const original = Reflect.get(target, key, receiver) as (
          ref: unknown,
        ) => Record<PropertyKey, unknown>;
        if (typeof original !== 'function') return original;

        return (ref: unknown) => scopeHandleEvents(id, original(ref), SCOPED_CONNECTION_METHODS);
      }

      // `ctx.kv.get/set/delete('k')` / `ctx.kv.list('prefix')` — the key (or
      // prefix) is namespaced so two plugins (or a plugin and the app) never
      // collide on the same kv key.
      if (key === 'kv') {
        const realKv = Reflect.get(target, key, receiver) as Record<PropertyKey, unknown> | null;
        if (!realKv || typeof realKv !== 'object') return realKv;
        const privileged = (realKv as { [PRIVILEGED_KV]?: Record<PropertyKey, unknown> })[
          PRIVILEGED_KV
        ];
        return (kvProxy ??= scopeKvApi(id, privileged ?? realKv));
      }

      // `ctx.channel.send/broadcast/request/...('evt', ...)` from inside a plugin
      // channel handler — the channel's child events are namespaced at
      // declaration, so the runtime looks them up by `__<id>::<evt>`. The handle
      // is a fresh object per dispatch, so wrap its event-first sends.
      if (key === 'channel') {
        const realChannel = Reflect.get(target, key, receiver);
        if (!realChannel || typeof realChannel !== 'object') return realChannel;
        return scopeHandleEvents(
          id,
          realChannel as Record<PropertyKey, unknown>,
          SCOPED_CHANNEL_SENDS,
        );
      }

      if (key === 'channels') {
        const realChannels = Reflect.get(target, key, receiver);
        if (!realChannels || typeof realChannels !== 'object') return realChannels;
        return scopeChannelsApi(id, realChannels as Record<PropertyKey, unknown>);
      }

      // `ctx.tags.<kind>('group')` — the group name is namespaced so a plugin's
      // tag reads/writes land on its own declared groups.
      if (key === 'tags') {
        const realTags = Reflect.get(target, key, receiver);
        if (!realTags || typeof realTags !== 'object') return realTags;

        return (tagsProxy ??= scopeTagsApi(id, realTags as Record<PropertyKey, unknown>));
      }

      const position = typeof key === 'string' ? SCOPED_SENDS[key] : undefined;
      if (!position) return Reflect.get(target, key, receiver);

      const original = Reflect.get(target, key, receiver) as (...args: unknown[]) => unknown;
      if (position === 'event-first') {
        return (event: unknown, ...rest: unknown[]) =>
          original(pluginWireName(id, event as string), ...rest);
      }

      return (first: unknown, event: unknown, ...rest: unknown[]) =>
        original(first, pluginWireName(id, event as string), ...rest);
    },
  });
}

/** Rethrow a plugin-thrown declared error under its namespaced wire code, keeping detail. */
function rethrowNamespaced(id: string, shortCodes: Set<string>, error: unknown): never {
  // Only the plugin's own declared short codes get namespaced; any other throw
  // (including arbitrary WSKitErrors) is left alone so it still normalizes as-is.
  if (error instanceof WSKitError && shortCodes.has(error.code)) {
    throw new WSKitError(pluginWireName(id, error.code), error.detail);
  }
  throw error;
}

/**
 * Run plugin user code and, on a thrown `WSKitError` whose code is one of the
 * plugin's declared short codes, rethrow it under the namespaced wire code so it
 * matches `declaredErrorCodes` and reaches the client instead of collapsing to
 * `internal-error`. Handles async: a returned promise is caught too. A plugin
 * that declares no errors gets the bare function back with no wrapping.
 */
export function scopePluginThrow<TArgs extends unknown[], TReturn>(
  id: string,
  shortCodes: Set<string>,
  fn: (...args: TArgs) => TReturn,
): (...args: TArgs) => TReturn {
  if (shortCodes.size === 0) return fn;
  return (...args: TArgs): TReturn => {
    let result: TReturn;
    try {
      result = fn(...args);
    } catch (error) {
      rethrowNamespaced(id, shortCodes, error);
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).catch((error) =>
        rethrowNamespaced(id, shortCodes, error),
      ) as unknown as TReturn;
    }
    return result;
  };
}

/**
 * Wrap a handle (a `ctx.connection(ref)` or `ctx.channel` object) so each named
 * method prefixes its first arg — the event name — with the plugin namespace.
 * Other methods on the handle pass through untouched.
 */
function scopeHandleEvents(
  id: string,
  handle: Record<PropertyKey, unknown>,
  methods: Set<string>,
): Record<PropertyKey, unknown> {
  return new Proxy(handle, {
    get(target, key, receiver) {
      const original = Reflect.get(target, key, receiver);
      if (typeof key !== 'string' || !methods.has(key) || typeof original !== 'function') {
        return original;
      }
      return (event: unknown, ...rest: unknown[]) =>
        (original as (...args: unknown[]) => unknown)(pluginWireName(id, event as string), ...rest);
    },
  });
}

/**
 * Namespace the lookup target of `ctx.channels.get(...)` so a plugin resolves
 * its own `__<id>::room` rather than the host's bare `room`. Mirrors the runtime
 * normalizer: a `(family, name)` pair namespaces the family; a channel decl
 * (`__wskitChannel.__key`) or `.at()` ref (`__wskitChannelRef.family`) namespaces
 * the family/key in place; a plain string name is namespaced directly. The
 * concrete instance `name` in a ref is a runtime value, not a declared key, so it
 * is left untouched.
 */
function scopeChannelGetArgs(id: string, args: unknown[]): unknown[] {
  if (args.length >= 2) return [pluginWireName(id, args[0] as string), ...args.slice(1)];
  const arg = args[0];
  if (arg && typeof arg === 'object') {
    if ('__wskitChannelRef' in arg) {
      const ref = arg as unknown as { family: string; name: string };
      return [{ ...ref, family: pluginWireName(id, ref.family) }];
    }
    if ('__wskitChannel' in arg) {
      const decl = arg as unknown as { __key: string };
      return [{ ...decl, __key: pluginWireName(id, decl.__key) }];
    }
    return [arg];
  }
  return [pluginWireName(id, arg as string)];
}

/**
 * Wrap `ctx.channels` so `get(...)` namespaces its target and the resolved
 * handle's event-first sends (`send`/`broadcast`/`request`/`broadcastRequest`)
 * carry the plugin namespace — the channel's child events are declared under
 * `__<id>::`, so the runtime looks them up there.
 */
function scopeChannelsApi(id: string, channels: Record<PropertyKey, unknown>): unknown {
  return new Proxy(channels, {
    get(target, key, receiver) {
      const original = Reflect.get(target, key, receiver);
      if (key !== 'get' || typeof original !== 'function') return original;
      const call = original as (...args: unknown[]) => Record<PropertyKey, unknown>;
      return (...args: unknown[]) =>
        scopeHandleEvents(id, call(...scopeChannelGetArgs(id, args)), SCOPED_CHANNEL_SENDS);
    },
  });
}

/**
 * Wrap `ctx.kv` so `get`/`set`/`delete` namespace their key and `list`
 * namespaces its prefix. A `::` in a kv key is fine, so the same
 * `pluginWireName(id, key)` scheme used on the wire works here too.
 */
function scopeKvApi(id: string, kv: Record<PropertyKey, unknown>): unknown {
  const nsPrefix = pluginWireName(id, '');
  return new Proxy(kv, {
    get(target, key, receiver) {
      const original = Reflect.get(target, key, receiver);
      if (typeof key !== 'string' || !SCOPED_KV_KEYS.has(key) || typeof original !== 'function') {
        return original;
      }
      const call = original as (...args: unknown[]) => unknown;
      // `list(prefix?)` is optional; a bare `list()` scopes to the plugin's whole
      // namespace so it never sees the app's or another plugin's keys.
      if (key === 'list') {
        return async (prefix?: unknown, ...rest: unknown[]) => {
          const keys = (await call(pluginWireName(id, (prefix as string) ?? ''), ...rest)) as
            | string[]
            | undefined;
          if (!Array.isArray(keys)) return keys;
          return keys.map((k) => (k.startsWith(nsPrefix) ? k.slice(nsPrefix.length) : k));
        };
      }
      return (keyArg: unknown, ...rest: unknown[]) =>
        call(pluginWireName(id, keyArg as string), ...rest);
    },
  });
}

/**
 * Scope the `helpers` a plugin `upgrade` hook receives so its tag-ref builders
 * namespace the group. A plugin's `helpers.tags.ephemeral('room').ref(key)` then
 * lands in `__<id>::room` — the group it actually declared — instead of the
 * host's bare `room` (which would be rejected or leak across the boundary). A
 * helpers bag without `tags` (no tag groups declared) passes through untouched.
 */
export function scopeUpgradeHelpers(id: string, helpers: any): any {
  const tags = helpers?.tags;
  if (!tags || typeof tags !== 'object') return helpers;
  return { ...helpers, tags: scopeTagsApi(id, tags as Record<PropertyKey, unknown>) };
}

/**
 * Wrap `ctx.tags` so `tags.ephemeral('group')` / `tags.persistent('group')`
 * namespace the group, and the returned handle's event-first `broadcastRequest`
 * (on the group and on `.ref(key)`) carries the plugin namespace — the request
 * is declared under `__<id>::`, so it must go out there too.
 */
function scopeTagsApi(id: string, tags: Record<PropertyKey, unknown>): unknown {
  return new Proxy(tags, {
    get(target, key, receiver) {
      if (typeof key === 'string' && TAG_KINDS.has(key)) {
        const original = Reflect.get(target, key, receiver) as (group: string) => unknown;
        if (typeof original !== 'function') return original;

        return (group: string) => scopeTagHandle(id, original(pluginWireName(id, group)));
      }

      return Reflect.get(target, key, receiver);
    },
  });
}

/** Scope a tag-group handle's `broadcastRequest`, recursing through `.ref(key)`. */
function scopeTagHandle(id: string, handle: unknown): unknown {
  if (!handle || typeof handle !== 'object') return handle;
  return new Proxy(handle as Record<PropertyKey, unknown>, {
    get(target, key, receiver) {
      const original = Reflect.get(target, key, receiver);
      if (typeof original !== 'function') return original;
      if (key === 'broadcastRequest') {
        return (event: unknown, ...rest: unknown[]) =>
          (original as (...args: unknown[]) => unknown)(
            pluginWireName(id, event as string),
            ...rest,
          );
      }
      if (key === 'ref') {
        return (refKey: unknown) =>
          scopeTagHandle(id, (original as (k: unknown) => unknown)(refKey));
      }
      return original;
    },
  });
}
