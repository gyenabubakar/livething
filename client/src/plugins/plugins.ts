/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin api/contract stay generic across call sites */
import { WSKitConfigError } from '@wskit/core';
import { runMessageHook } from '~/internal/dispatch.ts';
import { toWSKitError } from '~/internal/error-frame.ts';
import { idGenerator } from '~/internal/id.ts';
import { NAMESPACE_DELIMITER, namespacedName } from '~/internal/namespace.ts';
import { applyAugmenters } from '~/internal/scoped.ts';
import type { WSKitError } from '@wskit/core';
import type { PrimitiveHelpers, PrimitiveRuntime, WireMessage } from '~/internal/runtime.ts';
import type { MessagingObject, ScopeInfo } from '~/internal/scoped.ts';
import type { PluginSocket } from '~/plugins/plugin-socket.ts';
import type {
  PluginDef,
  PluginFactory,
  PluginInstance,
  PrimitiveFactory,
} from '~/plugins/types.ts';
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
type CloseHook = (code: number, reason: string, suspended: boolean) => void;

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
  def: PluginDef<P, TApi>,
  helpers: PrimitiveHelpers,
  observing: boolean,
): PrimitiveRuntime {
  const id = def.id;
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const errorHandlers = new Set<(error: WSKitError) => void>();
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

  // A verb that comes from a primitive the app didn't register is absent at
  // runtime. Seed a clear thrower so calling it names the primitive to add,
  // instead of a bare "x is not a function"; applyAugmenters overwrites the ones
  // whose primitive IS registered. The throwers hold no primitive code, so they
  // don't affect tree-shaking.
  function missing(verb: string, primitive: string): () => never {
    return () => {
      throw new WSKitConfigError(
        `[wskit] plugin '${id}' used socket.${verb}(), but the ${primitive} primitive isn't registered. ` +
          `List ${primitive} in the plugin's dependencies and register ${primitive}() in client().`,
      );
    };
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

  const ownPrefix = namespacedName(id, '');

  // The scoped socket's own surface. Plain names are used here; `send` adds the
  // prefix on the way out and the pipeline hook strips it on the way in. The rest
  // of the verbs are grafted on by applyAugmenters at install.
  const socket = {
    on(event: string, handler: (data: unknown) => void): () => void {
      // Hold the socket open while listening, like the top-level `on`, so a lazy
      // socket a receive-only plugin drives doesn't idle-close out from under it.
      helpers.lazyAcquire();
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        set.delete(handler);
        if (set.size === 0) handlers.delete(event);
        helpers.lazyRelease();
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

    onError(handler: (error: WSKitError) => void): () => void {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },

    generateId: (prefix?: string) => idGenerator(helpers)(prefix),
    hasPrimitive: (tag: string) => helpers.hasPrimitive(tag),
    ensureConnected: () => helpers.ensureConnected(),
    state: helpers.state,

    // Primitive-backed verbs: clear throwers until applyAugmenters replaces the
    // ones whose primitive is registered.
    request: missing('request', 'requestResponse'),
    stream: missing('stream', 'stream'),
    onStream: missing('onStream', 'stream'),
    resumeStream: missing('resumeStream', 'stream'),
    onRequest: missing('onRequest', 'serverRequest'),
    channel: missing('channel', 'channels'),
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

  // Frames a plugin returns from onOpen/onReconnect carry plain names, like send();
  // stamp each with the plugin's namespace so it lands in the plugin's own space.
  function namespaceFrames(frames: WireMessage[] | void): WireMessage[] | null {
    if (!frames) return null;
    return frames.map((frame) => ({ ...frame, event: namespacedName(id, frame.event) }));
  }

  // Whether a frame belongs to this plugin's namespace: a `__<id>::` event, or an
  // error frame whose code is namespaced. Raw taps see only these unless the
  // plugin was granted host observation.
  function inNamespace(message: WireMessage): boolean {
    if (message.event.startsWith(ownPrefix)) return true;
    if (message.event === '__error__') {
      const code = (message.payload as { code?: unknown } | null)?.code;
      return typeof code === 'string' && code.startsWith(ownPrefix);
    }
    return false;
  }

  function dispatchError(error: WSKitError): void {
    for (const handler of errorHandlers) {
      try {
        handler(error);
      } catch (e) {
        report(e);
      }
    }
  }

  /*
   * A server-pushed error in this plugin's namespace arrives as an `__error__`
   * frame whose `code` reads `__<id>::<name>`. An error tied to a request or
   * stream is already claimed by that primitive before the plugin sees it, so one
   * reaching here is unsolicited. The plugin owns its whole namespace, errors
   * included, so it always claims one: a scoped handler gets it with the prefix
   * stripped; with no handler it surfaces through the reported-error path (the
   * app's onError catch-all) rather than leaking into the app as a normal frame.
   */
  function claimError(message: WireMessage): boolean {
    if (message.event !== '__error__' || !ownsFrame(message)) return false;
    const payload = message.payload as { code?: unknown; detail?: unknown } | null;
    if (typeof payload?.code !== 'string' || !payload.code.startsWith(ownPrefix)) return false;
    if (errorHandlers.size > 0) {
      // Same reconstruction the top-level onError uses; hand over the plain code.
      dispatchError(
        toWSKitError({ code: payload.code.slice(ownPrefix.length), detail: payload.detail }),
      );
    } else {
      // Keep the namespaced code here so it stays unambiguous at the app level.
      report(toWSKitError(message.payload));
    }
    return true;
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
      if (userIncoming && (observing || inNamespace(current))) {
        const run = userIncoming;
        const result = runMessageHook((m) => run(m) ?? m, current, report);
        if (result === null) return null;
        current = result;
      }
      if (current.event.startsWith(ownPrefix) && ownsFrame(current)) {
        dispatch(current.event.slice(ownPrefix.length), current.payload);
        return null;
      }
      if (claimError(current)) return null;
      return current;
    },

    onOutgoing(message) {
      if (!userOutgoing || !(observing || inNamespace(message))) return message;
      const run = userOutgoing;
      return runMessageHook((m) => run(m) ?? m, message, report);
    },

    onOpen() {
      if (!userOpen) return null;
      try {
        return namespaceFrames(userOpen());
      } catch (error) {
        report(error);
        return null;
      }
    },

    onReconnect() {
      if (!userReconnect) return null;
      try {
        return namespaceFrames(userReconnect());
      } catch (error) {
        report(error);
        return null;
      }
    },

    onClose(...args) {
      const [code, reason, intentional, suspended] = args;
      if (userClose) {
        try {
          userClose(code, reason, !!suspended);
        } catch (error) {
          report(error);
        }
      }
      // A platform suspend pauses the session and resumes it as the same socket,
      // so it must not dispose — even though the socket goes to 'closed'.
      if (suspended) return;
      // A lazy socket reopens on demand, so no close is ever "finished for good":
      // disposing on one would tear the plugin down while it's still usable, then
      // keep delivering to a disposed plugin after the next reopen.
      if (helpers.config.lazy) return;
      if (intentional) {
        runDispose();
      } else {
        // An unexpected drop settles by the next microtask: dispose only if it
        // ends 'closed' (finished for good), not while a reconnect is in flight.
        queueMicrotask(() => {
          if (helpers.getState() === 'closed') runDispose();
        });
      }
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
 * You call it in two steps, like `client()`: first the contract and api types,
 * then the definition. The `id` is inferred as a literal from the second call, so
 * the app socket knows which namespace this plugin claims.
 *
 * ```ts
 * const Chat = plugin<ChatContract, ChatApi>()({
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
export function plugin<P extends SocketContract = {}, TApi = void>() {
  return function define<const TId extends string, const TObservesHost extends boolean = false>(
    def: PluginDef<P, TApi> & { id: TId; observesHostTraffic?: TObservesHost },
  ): PluginFactory<TApi, TId, P, TObservesHost> {
    const dependencies = def.dependencies?.map(resolveTag);
    const id = def.id;
    const observesHostTraffic = def.observesHostTraffic === true;

    // `::` separates the id from the name on the wire, so an id that contains it
    // would make one plugin's prefix a prefix of another's — and swallow its
    // frames. Ids follow the `vendor:name` convention (a single colon).
    if (id.includes(NAMESPACE_DELIMITER)) {
      throw new WSKitConfigError(
        `[wskit] plugin id '${id}' must not contain '${NAMESPACE_DELIMITER}' — use a single colon, like 'vendor:name'.`,
      );
    }

    const factory = Object.assign(
      () => {
        // Build the spec first so `setup` can read the grant flag that
        // observeHost(...) sets on this exact object, before buildSocket runs it.
        const spec = {
          _tag: id,
          _plugin: { id },
          __observesHostTraffic: observesHostTraffic,
          dependencies,
          setup: (helpers: PrimitiveHelpers) =>
            createPluginRuntime(
              def,
              helpers,
              observesHostTraffic &&
                (spec as { __hostObservationGranted?: boolean }).__hostObservationGranted === true,
            ),
        };
        return spec;
      },
      {
        id,
        use: (socket: object): TApi => usePlugin(socket, id) as TApi,
      },
    ) as unknown as PluginFactory<TApi, TId, P, TObservesHost>;

    return factory;
  };
}

/**
 * Grant a plugin that declared `observesHostTraffic: true` the right to see the
 * whole app's frames in its `onIncoming`/`onOutgoing` taps. Wrap the registered
 * plugin where you pass it to `client()`:
 *
 * ```ts
 * client<AppContract>()(connect('wss://...'), observeHost(Logger()));
 * ```
 *
 * Without the wrap, registering such a plugin is a type error — the grant is
 * explicit so host-wide observation is always visible at the call site. A plugin
 * that does not observe host traffic never needs this.
 */
export function observeHost<TSpec extends { readonly _plugin: { readonly id: string } }>(
  granted: TSpec,
): Omit<TSpec, '__requiresHostGrant'> & { readonly __hostObservationGranted: true } {
  (granted as { __hostObservationGranted?: boolean }).__hostObservationGranted = true;
  return granted as unknown as Omit<TSpec, '__requiresHostGrant'> & {
    readonly __hostObservationGranted: true;
  };
}
