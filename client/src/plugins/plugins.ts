/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin api/contract stay generic across call sites */
import { WSKitConfigError } from '@wskit/core';
import { runMessageHook } from '~/internal/dispatch.ts';
import { namespacedName, parseNamespaced } from '~/internal/namespace.ts';
import { applyAugmenters } from '~/internal/scoped.ts';
import type { PrimitiveHelpers, PrimitiveRuntime, WireMessage } from '~/internal/runtime.ts';
import type { MessagingObject, ScopeInfo } from '~/internal/scoped.ts';
import type { PluginSocket } from '~/plugins/plugin-socket.ts';
import type {
  PluginDef,
  PluginFactory,
  PluginInstance,
  PrimitiveFactory,
} from '~/plugins/types.ts';
import type { EmptyTypeFn, Primitive } from '~/primitives/types.ts';
import type { WSKitSocket } from '~/socket/socket.ts';
import type { SocketContract } from '~/types.ts';

/**
 * Read a dependency's tag from the factory's static `tag` without running it.
 * Calling a configured factory with no args could throw or fire side effects, so
 * a dependency must expose `tag`. A bad dependency is caught here, when the plugin
 * is defined, not at runtime.
 */
function resolveTag(factory: PrimitiveFactory): string {
  if (typeof factory.tag === 'string') return factory.tag;
  throw new WSKitConfigError(
    `[wskit] a plugin dependency must be a primitive factory with a static 'tag' (e.g. [requestResponse, channels]).`,
  );
}

/**
 * Plugin APIs per socket, built on first `use()`. Keyed by the plugin's `id`.
 * Held in a module-scoped WeakMap rather than on the socket so the core socket
 * carries no plugin code — it's only here when `plugin()` is in the bundle. Keyed
 * weakly by socket, so a dropped socket takes its plugin entries with it.
 */
type PluginResult = { ok: true; api: unknown } | { ok: false; error: unknown };
type PluginEntry = { build: () => unknown; result?: PluginResult };
const pluginRegistries = new WeakMap<object, Map<string, PluginEntry>>();

function registerPlugin(socket: WSKitSocket, id: string, build: () => unknown): void {
  let byId = pluginRegistries.get(socket);
  if (!byId) {
    byId = new Map();
    pluginRegistries.set(socket, byId);
  }
  byId.set(id, { build });
}

function usePlugin(socket: object, id: string): unknown {
  const entry = pluginRegistries.get(socket)?.get(id);
  if (!entry) {
    throw new WSKitConfigError(
      `[wskit] plugin '${id}' is not registered on this socket, or it exposes no API. Pass it to client().`,
    );
  }
  if (!entry.result) {
    try {
      entry.result = { ok: true, api: entry.build() };
    } catch (error) {
      entry.result = { ok: false, error };
    }
  }
  if (!entry.result.ok) throw entry.result.error;
  return entry.result.api;
}

type IncomingHook = (message: WireMessage) => WireMessage | void;
type OpenHook = () => WireMessage[] | void;
type CloseHook = (code: number, reason: string) => void;

/**
 * A plugin only owns plain top-level frames in its namespace. A frame carrying a
 * channel, correlationId, or streamId belongs to the channels, requestResponse,
 * or stream primitive — those run before the plugin and handle it — so the plugin
 * leaves it alone even when the name is in the plugin's namespace.
 */
function ownsFrame(message: WireMessage): boolean {
  const envelope = message.__wskit;
  return !envelope?.channel && !envelope?.correlationId && !envelope?.streamId;
}

/**
 * Build the runtime for one registered plugin: the scoped socket its `setup`
 * sees, the handler registry its `on(...)` fills, and the pipeline hooks that
 * route its namespace to it and run its cleanup.
 */
function createPluginRuntime<P extends SocketContract, TApi>(
  id: string,
  def: PluginDef<P, TApi>,
  helpers: PrimitiveHelpers,
): PrimitiveRuntime {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  let disposed = false;
  let instance: PluginInstance<TApi> | null = null;

  let userIncoming: IncomingHook | null = null;
  let userOutgoing: IncomingHook | null = null;
  let userOpen: OpenHook | null = null;
  let userReconnect: OpenHook | null = null;
  let userClose: CloseHook | null = null;

  function once<T>(name: string, current: T | null, handler: T): T {
    if (current) {
      throw new WSKitConfigError(
        `[wskit] plugin '${id}' registered ${name}() twice — use a single callback.`,
      );
    }
    return handler;
  }

  function report(error: unknown): void {
    helpers.log.report(error);
  }

  /*
   * The plugin's scope. `markers` is empty — a plugin isn't a channel, so its
   * frames carry no channel marker — and `prefixName` adds the `__<id>::` prefix.
   * Every scope-aware primitive reads these, so `request`, `stream`, `onRequest`,
   * and `channel` come from the primitives that provide them (added by
   * applyAugmenters at install), not from here. That keeps them out of the bundle
   * unless the app registers those primitives, exactly like the top-level socket.
   */
  const scope: ScopeInfo = {
    markers: () => ({}),
    prefixName: (name) => namespacedName(id, name),
  };

  // The scoped socket's own surface. Plain names are used here; `send` adds the
  // prefix on the way out and the pipeline hook strips it on the way in. The rest
  // of the verbs are grafted on by applyAugmenters at install.
  const socket = {
    on(event: string, handler: (data: unknown) => void): () => void {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
        if (set.size === 0) handlers.delete(event);
      };
    },

    send(event: string, payload: unknown, options?: { ttl?: number }): boolean {
      const result = helpers.send({ event: namespacedName(id, event), payload }, options);
      return result === 'sent' || result === 'buffered';
    },

    onIncoming: (handler: IncomingHook) =>
      void (userIncoming = once('onIncoming', userIncoming, handler)),
    onOutgoing: (handler: IncomingHook) =>
      void (userOutgoing = once('onOutgoing', userOutgoing, handler)),
    onOpen: (handler: OpenHook) => void (userOpen = once('onOpen', userOpen, handler)),
    onReconnect: (handler: OpenHook) =>
      void (userReconnect = once('onReconnect', userReconnect, handler)),
    onClose: (handler: CloseHook) => void (userClose = once('onClose', userClose, handler)),

    generateId: (prefix?: string) => helpers.generateId(prefix),
    hasPrimitive: (tag: string) => helpers.hasPrimitive(tag),
    ensureConnected: () => helpers.ensureConnected(),
    getState: () => helpers.getState(),
  };

  function dispatch(name: string, payload: unknown): void {
    const set = handlers.get(name);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (error) {
        report(error);
      }
    }
  }

  function runDispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      instance?.dispose?.();
    } catch (error) {
      report(error);
    }
  }

  return {
    id,

    install(hostSocket) {
      // Primitives install before plugins, so their augmenters are ready here.
      // Graft the scope-aware verbs on, then run setup with the full socket.
      applyAugmenters(hostSocket, socket as unknown as MessagingObject, scope);
      instance = def.setup(socket as unknown as PluginSocket<P>);
      if (instance.api) registerPlugin(hostSocket, id, instance.api);
    },

    onIncoming(message) {
      let current = message;
      if (userIncoming) {
        const run = userIncoming;
        const result = runMessageHook((m) => run(m) ?? m, current, report);
        if (result === null) return null;
        current = result;
      }
      const parsed = parseNamespaced(current.event);
      if (parsed && parsed.id === id && ownsFrame(current)) {
        dispatch(parsed.name, current.payload);
        return null;
      }
      return current;
    },

    onOutgoing(message) {
      if (!userOutgoing) return message;
      const run = userOutgoing;
      return runMessageHook((m) => run(m) ?? m, message, report);
    },

    onOpen() {
      if (!userOpen) return null;
      try {
        return userOpen() ?? null;
      } catch (error) {
        report(error);
        return null;
      }
    },

    onReconnect() {
      if (!userReconnect) return null;
      try {
        return userReconnect() ?? null;
      } catch (error) {
        report(error);
        return null;
      }
    },

    onClose(code, reason, intentional) {
      if (userClose) {
        try {
          userClose(code, reason);
        } catch (error) {
          report(error);
        }
      }
      // An intentional close is the app finishing for good. A transient drop
      // (intentional false) may reconnect, so it must not dispose; a platform
      // suspend is never an intentional close, so it's covered here too.
      if (intentional) runDispose();
    },

    onReconnectFailed() {
      runDispose();
    },
  };
}

/**
 * Define a reusable client feature that owns a namespace on the socket. Its
 * `setup` gets a scoped socket with the same verbs as the app socket — `on`,
 * `send`, `request`, `channel` — typed to the plugin's own contract and scoped to
 * its `id`, so you use plain names. Unlike a built-in primitive, a plugin adds
 * nothing to the socket's type; its API is reached with `Plugin.use(socket)`,
 * which keeps TypeScript fast.
 *
 * ```ts
 * const Chat = plugin<ChatContract, ChatApi>({
 *   id: 'acme:chat',
 *   dependencies: [requestResponse],
 *   setup(socket) {
 *     const inbox: Message[] = [];
 *     socket.on('message', (m) => inbox.push(m));
 *     return {
 *       api: () => ({
 *         history: () => inbox.slice(),
 *         send: (text: string) => socket.request('send-message', { text }),
 *       }),
 *     };
 *   },
 * });
 *
 * const socket = client<AppContract>()(connect('wss://...'), requestResponse(), Chat());
 * const chat = Chat.use(socket);
 * ```
 */
export function plugin<
  P extends SocketContract = {},
  TApi = void,
  const TId extends string = string,
>(def: PluginDef<P, TApi> & { id: TId }): PluginFactory<TApi, TId> {
  const dependencies = def.dependencies?.map(resolveTag);
  const id: TId = def.id;

  const factory = Object.assign(
    (): Primitive<EmptyTypeFn> & { readonly _plugin: { readonly id: TId } } => ({
      _tag: id,
      _plugin: { id },
      dependencies,
      setup: (helpers) => createPluginRuntime(id, def, helpers),
    }),
    {
      id,
      use: (socket: object): TApi => usePlugin(socket, id) as TApi,
    },
  );

  return factory;
}
