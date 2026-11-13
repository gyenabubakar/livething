/* oxlint-disable @typescript-eslint/no-explicit-any -- plugin api/contract stay generic across call sites */
import { LiveThingConfigError } from '@livething/core';
import { keepFrameKind, runMessageHook } from '~/internal/dispatch.ts';
import { toLiveThingError } from '~/internal/error-frame.ts';
import { idGenerator } from '~/internal/id.ts';
import { NAMESPACE_DELIMITER, namespacedName } from '~/internal/namespace.ts';
import { applyAugmenters, getAugmenters } from '~/internal/scoped.ts';
import type { LiveThingError } from '@livething/core';
import type { Message, PrimitiveHelpers, PrimitiveRuntime } from '~/internal/runtime.ts';
import type { MessagingObject, ScopeInfo } from '~/internal/scoped.ts';
import type { PluginSocket } from '~/plugins/plugin-socket.ts';
import type {
  LiteralDependencyTags,
  PluginDef,
  PluginFactory,
  PluginInstance,
  PrimitiveFactory,
} from '~/plugins/types.ts';
import type { LiveThingSocket } from '~/socket/socket.ts';
import type { SocketContract } from '~/types.ts';

/**
 * Read a dependency's tag from the factory's static `tag` without running it.
 * Calling a configured factory with no args could throw or fire side effects, so
 * a dependency must expose `tag`. A bad dependency is caught here, when the plugin
 * is defined, not at runtime.
 */
function resolveTag(factory: PrimitiveFactory): string {
  if (typeof factory.tag === 'string') return factory.tag;

  throw new LiveThingConfigError(
    `a plugin dependency must be a primitive factory with a static 'tag' (e.g. [clientRequests, channels]).`,
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

function registerPlugin(socket: LiveThingSocket, id: string, build: () => unknown): void {
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
    throw new LiveThingConfigError(
      `plugin '${id}' is not registered on this socket, or it exposes no API. Pass it to client().`,
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

type IncomingHook = (message: Message) => Message | void;
type OpenHook = () => Message[] | void;
type CloseHook = (code: number, reason: string, suspended: boolean) => void;
type PluginErrorRegistration = {
  code?: string;
  handler: (error: LiveThingError<string, unknown>) => void;
};

interface PluginSendOptions {
  ttl?: number;
}

/**
 * A plugin only owns plain top-level text frames in its namespace. A frame carrying a
 * channel, correlationId, or streamId belongs to the channels, clientRequests,
 * or stream primitive — those run before the plugin and handle it — so the plugin
 * leaves it alone even when the name is in the plugin's namespace. A binary frame goes
 * on to `binary()`, which gives it to the plugin's `binary.on` listeners.
 */
function ownsFrame(message: Message): boolean {
  const metadata = message.metadata;
  return !metadata?.channel && !metadata?.exchange && !metadata?.stream && !message.bytes;
}

/**
 * Build the runtime for one registered plugin: the scoped socket its `setup`
 * sees, the handler registry its `on(...)` fills, and the pipeline hooks that
 * route its namespace to it and run its cleanup.
 */
function createPluginRuntime<P extends SocketContract, TApi>(
  def: PluginDef<P, TApi>,
  helpers: PrimitiveHelpers,
): PrimitiveRuntime {
  const id = def.id;
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const errorHandlers = new Set<PluginErrorRegistration>();
  let disposed = false;
  let instance: PluginInstance<TApi> | null = null;

  // Stored pre-wrapped in the `runMessageHook` shape (a hook returning nothing
  // passes the message through), so no wrapper closure is built per frame.
  let userIncoming: ((message: Message) => Message) | null = null;
  let userOutgoing: ((message: Message) => Message) | null = null;
  let userOpen: OpenHook | null = null;
  let userReconnect: OpenHook | null = null;
  let userClose: CloseHook | null = null;

  function once<T>(name: string, current: T | null, handler: T): T {
    if (current) {
      throw new LiveThingConfigError(
        `plugin '${id}' registered ${name}() twice — use a single callback.`,
      );
    }

    return handler;
  }

  function report(error: unknown): void {
    helpers.log.report(error);
  }

  const withBinary = helpers.hasPrimitive('binary');

  // A verb that comes from a primitive the app didn't register is absent at
  // runtime. Seed a clear thrower so calling it names the primitive to add,
  // instead of a bare "x is not a function"; applyAugmenters overwrites the ones
  // whose primitive IS registered. The throwers hold no primitive code, so they
  // don't affect tree-shaking.
  function missing(verb: string, primitive: string): () => never {
    return () => {
      throw new LiveThingConfigError(
        `plugin '${id}' used socket.${verb}(), but the ${primitive} primitive isn't registered. ` +
          `List ${primitive} in the plugin's dependencies and register ${primitive}() in client().`,
      );
    };
  }

  function missingReceiptMethod(verb: string, primitive: 'inbox' | 'readReceipts'): () => never {
    return () => {
      throw new LiveThingConfigError(
        `plugin '${id}' used channel.${verb}(), but ${primitive}() is not registered. ` +
          `Register ${primitive}() in client().`,
      );
    };
  }

  function installMissingReceiptSurfaces(messaging: MessagingObject, scope: ScopeInfo): void {
    const markers = scope.markers();
    const channelOwner = markers.family ?? markers.name;
    if (channelOwner === undefined || !scope.prefixName || !channelOwner.startsWith(ownPrefix)) {
      return;
    }

    if (messaging.receivers === undefined) {
      const missingInbox = missingReceiptMethod('receivers', 'inbox');
      messaging.receivers = { get: missingInbox, subscribe: missingInbox };
      messaging.onReceived = missingReceiptMethod('onReceived', 'inbox');
      messaging.receiversOf = missingReceiptMethod('receiversOf', 'inbox');
    }

    if (messaging.readers === undefined) {
      const missingReadReceipts = missingReceiptMethod('readers', 'readReceipts');
      messaging.readers = { get: missingReadReceipts, subscribe: missingReadReceipts };
      messaging.onRead = missingReceiptMethod('onRead', 'readReceipts');
      messaging.readersOf = missingReceiptMethod('readersOf', 'readReceipts');
      messaging.markAsRead = missingReceiptMethod('markAsRead', 'readReceipts');
    }
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

    send(event: string, payload: unknown, options?: PluginSendOptions): boolean {
      if (typeof event !== 'string' || event.length === 0) return false;

      const result = helpers.send(
        { event: namespacedName(id, event), payload, metadata: null },
        options,
      );
      return result === 'sent' || result === 'buffered';
    },

    onIncoming: (handler: IncomingHook) =>
      void (userIncoming = once('onIncoming', userIncoming, (m) => handler(m) ?? m)),
    onOutgoing: (handler: IncomingHook) =>
      void (userOutgoing = once('onOutgoing', userOutgoing, (m) => handler(m) ?? m)),
    onOpen: (handler: OpenHook) => void (userOpen = once('onOpen', userOpen, handler)),
    onReconnect: (handler: OpenHook) =>
      void (userReconnect = once('onReconnect', userReconnect, handler)),
    onClose: (handler: CloseHook) => void (userClose = once('onClose', userClose, handler)),

    onServerError(
      codeOrHandler: string | ((error: LiveThingError<string, unknown>) => void),
      maybeHandler?: (error: LiveThingError<string, unknown>) => void,
    ): () => void {
      const code = typeof codeOrHandler === 'string' ? codeOrHandler : undefined;
      const handler = typeof codeOrHandler === 'function' ? codeOrHandler : maybeHandler;
      if (!handler) {
        throw new TypeError(`[livething] plugin '${id}' onServerError requires a callback.`);
      }

      const registration = { code, handler };
      errorHandlers.add(registration);

      return () => errorHandlers.delete(registration);
    },

    generateId: (prefix?: string) => idGenerator(helpers)(prefix),
    hasPrimitive: (tag: string) => helpers.hasPrimitive(tag),
    ensureConnected: () => helpers.ensureConnected(),
    state: helpers.state,

    // Primitive-backed verbs: clear throwers until applyAugmenters replaces the
    // ones whose primitive is registered.
    request: missing('request', 'clientRequests'),
    stream: missing('stream', 'stream'),
    onStream: missing('onStream', 'stream'),
    continueStream: missing('continueStream', 'stream'),
    onRequest: missing('onRequest', 'serverRequests'),
    channel: missing('channel', 'channels'),
    // binary() adds `on` and `send`; the others need their own primitive too. Name
    // binary() when it is the one missing.
    binary: {
      on: missing('binary.on', 'binary'),
      send: missing('binary.send', 'binary'),
      request: missing('binary.request', withBinary ? 'clientRequests' : 'binary'),
      onRequest: missing('binary.onRequest', withBinary ? 'serverRequests' : 'binary'),
      stream: missing('binary.stream', withBinary ? 'stream' : 'binary'),
      onStream: missing('binary.onStream', withBinary ? 'stream' : 'binary'),
      continueStream: missing('binary.continueStream', withBinary ? 'stream' : 'binary'),
    },
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
  function namespaceFrames(frames: Message[] | void): Message[] | null {
    if (!frames) return null;

    return frames.map((frame) => ({ ...frame, event: namespacedName(id, frame.event) }));
  }

  function dispatchError(error: LiveThingError): boolean {
    const matching = [...errorHandlers].filter(
      (registration) => registration.code === undefined || registration.code === error.code,
    );
    for (const { handler } of matching) {
      try {
        handler(error);
      } catch (e) {
        report(e);
      }
    }

    return matching.length > 0;
  }

  /*
   * A server-pushed error in this plugin's namespace arrives as an `__error__`
   * frame whose `code` reads `__<id>::<name>`. An error tied to a request or
   * stream is already claimed by that primitive before the plugin sees it, so one
   * reaching here is unsolicited. The plugin owns its whole namespace, errors
   * included, so it always claims one: a scoped handler gets it with the prefix
   * stripped; with no matching handler it reaches the host's onServerError path
   * rather than leaking into the app as a normal frame.
   */
  function claimError(message: Message): boolean {
    if (message.event !== '__error__' || !ownsFrame(message)) return false;

    const payload = message.payload as { code?: unknown; detail?: unknown } | null;
    if (typeof payload?.code !== 'string' || !payload.code.startsWith(ownPrefix)) return false;

    const error = toLiveThingError({
      code: payload.code.slice(ownPrefix.length),
      detail: payload.detail,
    });
    if (!dispatchError(error)) helpers.reportServerError(toLiveThingError(message.payload));

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
      getAugmenters(hostSocket).push(installMissingReceiptSurfaces);
      // Primitives install before plugins, so their augmenters are ready here.
      // Graft the scope-aware verbs on, then run setup with the full socket.
      applyAugmenters(hostSocket, socket as unknown as MessagingObject, scope);
      instance = def.setup(socket as unknown as PluginSocket<P>);
      if (instance.api) registerPlugin(hostSocket, id, instance.api);
    },

    onIncoming(message) {
      let current = message;
      if (userIncoming) {
        const bytes = message.bytes;
        const result = runMessageHook(userIncoming, current, report);
        if (result === null) return null;

        current = keepFrameKind(bytes, result);
      }

      if (current.event.startsWith(ownPrefix) && ownsFrame(current)) {
        dispatch(current.event.slice(ownPrefix.length), current.payload);
        return null;
      }

      if (claimError(current)) return null;

      return current;
    },

    onOutgoing(message) {
      if (!userOutgoing) return message;

      return runMessageHook(userOutgoing, message, report);
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

declare const inferredApi: unique symbol;

/** The default of `plugin()`'s API type argument: no API type was given. */
type InferredApi = typeof inferredApi;

/**
 * A plugin's API type: the one passed to `plugin<P, TApi>()` when given, so
 * `setup` must return it, or else the one inferred from `setup`.
 */
type PluginApi<TApi, TSetupApi> = [TApi] extends [InferredApi] ? TSetupApi : TApi;

/**
 * Define a reusable client feature that owns a namespace on the socket. Its
 * `setup` gets a scoped socket with the same verbs as the app socket — `on`,
 * `send`, `request`, `channel` — typed to the plugin's own contract and scoped to
 * its `id`, so you use plain names. Unlike a built-in primitive, a plugin adds
 * nothing to the socket's type; its API is reached with `Plugin.use(socket)`,
 * which keeps TypeScript fast.
 *
 * You call it in two steps, like `client()`: first the contract type, then the
 * definition. The `id` is inferred as a literal from the second call, so the app
 * socket knows which namespace this plugin claims, and the API type is inferred
 * from what `setup` returns — a plugin with no `api` gets `void`. Pass a second
 * type argument, `plugin<ChatContract, ChatApi>()`, only to pin the API to a type
 * you declared yourself: `setup` must then return an API of that type, and
 * `use()` returns that type.
 *
 * ```ts
 * const Chat = plugin<ChatContract>()({
 *   id: 'acme:chat',
 *   dependencies: [clientRequests],
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
 * const socket = client<AppContract>()(connect('wss://...'), clientRequests(), Chat());
 * const chat = Chat.use(socket);
 * ```
 */
export function plugin<P extends SocketContract = {}, TApi = InferredApi>() {
  return function define<
    const TId extends string,
    TSetupApi = void,
    const TDependencies extends readonly PrimitiveFactory[] = [],
  >(
    // A list like `[...base, channels]` infers a tuple type its own value doesn't
    // fit, so the plain array type is accepted too. The tuple has no fixed length,
    // so it gives no tags and the runtime check covers it.
    def: PluginDef<P, PluginApi<TApi, TSetupApi>> & {
      id: TId;
      dependencies?: TDependencies | readonly PrimitiveFactory[];
    },
  ): PluginFactory<PluginApi<TApi, TSetupApi>, TId, P, LiteralDependencyTags<TDependencies>> {
    const dependencies = def.dependencies?.map(resolveTag);
    const id = def.id;

    // `::` separates the id from the name on the wire, so an id that contains it
    // would make one plugin's prefix a prefix of another's — and swallow its
    // frames. Ids follow the `vendor:name` convention (a single colon).
    if (id.includes(NAMESPACE_DELIMITER)) {
      throw new LiveThingConfigError(
        `plugin id '${id}' must not contain '${NAMESPACE_DELIMITER}' — use a single colon, like 'vendor:name'.`,
      );
    }

    const factory = Object.assign(
      () => {
        const spec = {
          _tag: id,
          _plugin: { id },
          dependencies,
          setup: (helpers: PrimitiveHelpers) => createPluginRuntime(def, helpers),
        };

        return spec;
      },
      {
        id,
        use: (socket: object) => usePlugin(socket, id),
      },
    ) as unknown as PluginFactory<
      PluginApi<TApi, TSetupApi>,
      TId,
      P,
      LiteralDependencyTags<TDependencies>
    >;

    return factory;
  };
}
