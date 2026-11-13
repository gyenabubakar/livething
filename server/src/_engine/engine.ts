import { CloseCodes, LiveThingConfigError } from '@livething/core';
import { stopAlarmCoordinator } from '~/_engine/alarm.ts';
import { EngineCore } from '~/_engine/core.ts';
import * as EngineDeps from '~/_engine/engine.deps.ts';
import * as EngineConnectionRuntime from '~/_engine/runtime/connection.ts';
import * as EngineHibernation from '~/_engine/runtime/hibernation.ts';
import * as Initialize from '~/_engine/runtime/initialize.ts';
import {
  withInvocationScope,
  withInvocationScopeSync,
} from '~/_engine/runtime/invocation-scope.ts';
import { moveTokenToAuthorization } from '~/_engine/runtime/token.ts';
import { RESERVED_ADMIN_API_NAMES } from '~/admin/context.ts';
import { createInitContext } from '~/lifecycle/context.ts';
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as LifecycleTypes from '~/lifecycle/lifecycle.ts';
import type { Primitive } from '~/primitive.ts';
import type * as ServerTypes from '~/server-definition.ts';

type OptionsParameter = { terminal?: boolean };

type ConnectionDescriptor = EngineAdapterTypes.ConnectionDescriptor;
type ConnectionHandle = EngineAdapterTypes.ConnectionHandle;
type AuthDecision = EngineAdapterTypes.AuthDecision;

/**
 * Runs one compiled server definition. Adapters call methods on this class;
 * state lives on {@link EngineCore} and behaviour in `_engine/runtime/*` and
 * `_engine/registry/*`.
 *
 * @template TApi The `api` factory's return type, carried from the server definition so
 *   {@link Engine.admin} stays typed all the way out to the adapter.
 */
export class Engine<TApi = unknown> {
  /** State container. Exposed for internal plugins that need direct field access. @internal */
  readonly core: EngineCore;

  constructor(
    definition: ServerTypes.ServerDefinition<
      readonly Primitive[],
      ServerTypes.ServerContract,
      unknown,
      TApi
    >,
    options: EngineAdapterTypes.EngineOptions,
  ) {
    this.core = new EngineCore(definition, options);
  }

  /** Set the stable platform instance id before accepting connections. */
  setInstanceId(id: string): void {
    this.core.setInstanceId(id);
  }

  /** @internal */
  getLogger(): PublicApi.Logger {
    return this.core.logger;
  }

  /** True if the handler opted into hibernation. */
  usesHibernation(): boolean {
    return this.core.hibernationAllowed;
  }

  /** One-time startup: validate capabilities, install plugins, run boot + init hooks. */
  async initialize(): Promise<void> {
    await Initialize.initialize(this.core, EngineDeps.engineAccessDeps(this.core));
    // An `api` factory's method names are only knowable by running it, so a bad
    // name cannot be caught while assembling. Building the surface once here
    // moves the failure to boot instead of the first `admin()` call, which on a
    // cron or webhook route might be days later.
    if (this.core.adminApiFactory) this.admin();
  }

  /** Accept a new websocket and return the callbacks the adapter uses to drive it. */
  accept(socketKey: unknown, descriptor: ConnectionDescriptor): ConnectionHandle {
    const handle = EngineConnectionRuntime.acceptConnection(
      EngineDeps.connectionRuntime(this.core),
      socketKey,
      descriptor,
    );
    return this.wrapHandle(handle);
  }

  /** Rebuild a connection handle for a websocket woken from hibernation. */
  handleHibernationWake(socketKey: unknown): ConnectionHandle {
    if (!this.usesHibernation()) {
      throw new Error(
        '[livething] hibernation is not enabled for this server definition. Set `hibernation: true` in server().',
      );
    }

    const handle = EngineConnectionRuntime.wakeHibernatedConnection(
      EngineDeps.connectionRuntime(this.core),
      socketKey,
    );
    return this.wrapHandle(handle);
  }

  // Wrap each callback so any state changes the handler triggers collect into
  // one row write at the end of the handler instead of one row write per
  // change. Only covers what runs (and is awaited) inside the callback —
  // work scheduled with a setTimeout or a paused generator runs
  // after the callback returns, outside the scope, and writes right away.
  private wrapHandle(handle: ConnectionHandle): ConnectionHandle {
    return {
      handleMessage: (data) => withInvocationScope(this.core, () => handle.handleMessage(data)),
      handleBinaryMessage: (data) =>
        withInvocationScope(this.core, () => handle.handleBinaryMessage(data)),
      handleClose: (code, reason) =>
        withInvocationScope(this.core, () => handle.handleClose(code, reason)),
      handleError: (error) => withInvocationScope(this.core, () => handle.handleError(error)),
    };
  }

  /** Run the authenticate hook before the adapter commits to the handshake. */
  async authenticate(request: Request): Promise<AuthDecision> {
    const withToken = moveTokenToAuthorization(request);
    if (!withToken) return { reject: true, code: 400, reason: 'Invalid token subprotocol' };

    return EngineConnectionRuntime.authenticate(
      {
        authHooks: this.core.hooks.authenticate,
        pluginAuthHooks: this.core.hooks.pluginAuth,
        builderAuthHook: this.core.hooks.builderAuth,
        authHelpers: this.buildAuthHelpers(),
        asyncContext: this.core.asyncContext,
        logger: this.core.logger,
        isTagGroupDeclared: (kind, group) => this.core.isTagGroupDeclared(kind, group),
        getTagGroupSchema: (kind, group) => this.core.getTagGroupSchema(kind, group),
      },
      withToken,
    );
  }

  /**
   * Shut down the engine and every connection or plugin it owns.
   *
   * Set `terminal` only when the adapter is about to close the timer or storage
   * bindings it supplied. A non-terminal drain leaves alarm retries available
   * for runtimes such as Durable Objects that can receive more work later.
   */
  async handleShutdown(options: OptionsParameter = {}): Promise<void> {
    const core = this.core;
    if (options.terminal) await stopAlarmCoordinator(core);
    try {
      await EngineConnectionRuntime.handleShutdown({
        connections: core.connections,
        activeStreams: core.activeStreams,
        shutdownHooks: core.hooks.shutdown,
        pluginShutdownHooks: core.hooks.pluginLifecycle.shutdown,

        createContext: () => EngineDeps.connectionlessContext(core),

        cancelActiveStreamsForConnection: (connectionId) =>
          EngineConnectionRuntime.cancelActiveStreamsForConnection(
            { activeStreams: core.activeStreams },
            connectionId,
          ),

        handleConnectionClose: (connection) =>
          EngineDeps.handleConnectionClose(core, {
            connection,
            code: CloseCodes.GOING_AWAY,
            reason: 'Server shutting down',
          }),

        logger: core.logger,
        asyncContext: core.asyncContext,
      });
    } finally {
      if (options.terminal) await core.drainBackgroundWork();
    }
  }

  /** Run scheduled hooks after a timer wake-up. Scheduled tasks drain via this path. */
  async handleAlarm(): Promise<void> {
    await withInvocationScope(this.core, () =>
      Initialize.handleAlarm(this.core, EngineDeps.engineAccessDeps(this.core)),
    );
  }

  /**
   * Drop persisted connection rows whose ids are not in `surviving`. Adapters
   * call this at boot with the sockets the platform still holds (empty set =
   * wipe all).
   */
  reconcileConnections(surviving: ReadonlySet<string>): void {
    EngineHibernation.reconcileConnections(this.core, surviving);
  }

  /**
   * Restore every socket the platform still holds after a hibernation eviction.
   * Each runs the same per-socket wake the lazy path uses, rebuilding its
   * identity, tags, and ephemeral channel membership at boot so a live broadcast
   * reaches even members whose own socket has not woken. Rows for absent ids are
   * pruned. The Promise rejects if any wake fails; adapters must await it before
   * handling platform events. A no-op without hibernation.
   */
  async restoreHibernatedConnections(sockets: Iterable<unknown>): Promise<void> {
    if (!this.usesHibernation()) return;

    const runtime = EngineDeps.connectionRuntime(this.core);
    const restored = new Set<string>();
    EngineHibernation.withPreloadedConnectionRows(this.core, () => {
      for (const socketKey of sockets) {
        withInvocationScopeSync(this.core, () => {
          EngineConnectionRuntime.wakeHibernatedConnection(runtime, socketKey);
        });
        const id = this.core.socketToConnectionId.get(socketKey);
        if (id) restored.add(id);
      }
    });
    EngineHibernation.reconcileConnections(this.core, restored);
  }

  /** Build the helper bag passed to every `onAuthenticate` hook. @internal */
  private buildAuthHelpers(): LifecycleTypes.AuthHelpers {
    const ctx = createInitContext({
      logger: this.core.logger,
      platform: this.core.platform,
      getStorageView: EngineDeps.commonDeps(this.core).getStorageView,
    });
    if (!this.core.usesTags()) return { ctx };

    const isDeclared = (kind: 'ephemeral' | 'persistent', group: string) =>
      this.core.declaredTagGroups[kind].has(group);

    function buildRefFactory(kind: 'ephemeral' | 'persistent') {
      return (group: string) => {
        if (!isDeclared(kind, group)) {
          throw new Error(
            `[livething] tag group '${group}' is not declared under tags (${kind}). Add it to your contract's tags: builder or check for a typo.`,
          );
        }

        return {
          ref: (key: string): PublicApi.TagRef => ({
            __livething: 'tag-ref',
            kind,
            group,
            key,
          }),
        };
      };
    }

    return {
      ctx,
      tags: {
        ephemeral: buildRefFactory('ephemeral'),
        persistent: buildRefFactory('persistent'),
      },
    };
  }

  /**
   * The connectionless admin surface, reached from outside the socket layer (an
   * HTTP route, an auth webhook, a cron job). Returns the full admin context
   * merged with the app's own `api` (authored on `assemble({ handlers, api })`).
   * Built-in members win on a name clash — a dev api method cannot shadow
   * `broadcast`, `purgeUser`, and the rest.
   *
   * Adapters decide what of this reaches the outside world. An in-process
   * adapter hands it back whole; the Cloudflare adapter projects it onto an
   * `RpcTarget`, because only prototype methods survive a Worker→DO call.
   */
  admin(): PublicApi.ConnectionlessContext<Record<string, unknown>, unknown> & TApi {
    const core = this.core;
    const ctx = EngineDeps.connectionlessContext(core);
    const devApi = core.adminApiFactory ? core.adminApiFactory(ctx) : {};
    // Copy descriptors rather than spreading: `connectionCount` is a getter and
    // must stay live, and the built-ins have to land after the dev api to win.
    const surface = flattenApi(devApi);
    Object.defineProperties(surface, Object.getOwnPropertyDescriptors(ctx));

    return surface as PublicApi.ConnectionlessContext<Record<string, unknown>, unknown> & TApi;
  }
}

/**
 * Reject an `api` method whose name JavaScript has already claimed. Enforced in
 * the engine rather than in each adapter, so the rule holds wherever the admin
 * surface is exposed from.
 *
 * Checked as each name is read off the factory's result, before the
 * already-seen guard: `'__proto__' in flat` holds on any plain object, so
 * without this a method by that name would be dropped without a word.
 */
function assertNotReservedApiName(key: string): void {
  if (!RESERVED_ADMIN_API_NAMES.has(key)) return;

  let reason: string;
  if (key === 'then') {
    reason =
      `'then' makes any object a thenable, so \`await service.admin()\` calls it ` +
      `instead of resolving. The await never settles.`;
  } else if (key === 'constructor') {
    reason =
      `'constructor' is JavaScript's prototype marker. An app member by this name ` +
      `cannot be exposed on the admin surface.`;
  } else {
    reason =
      `'${key}' is already inherited by the plain object the admin surface is ` +
      `built on. A method by this name cannot be placed on the surface — the ` +
      `inherited one is already there — and would go missing without explanation.`;
  }

  throw new LiveThingConfigError(
    `assemble({ api }) declared the reserved method name '${key}'. ${reason} Rename it.`,
  );
}

/**
 * A class or ordinary function puts this non-enumerable, configurable,
 * writable data property on its prototype. It is not an app API member, so do
 * not reject it while walking a class instance's prototype chain. The check
 * deliberately reads the constructor's `prototype` descriptor instead of the
 * property itself: an app can return a function or proxy with a getter there,
 * and reserved-name validation must not execute app code.
 */
function isAutomaticConstructorMarker(
  api: object,
  level: object,
  descriptor: PropertyDescriptor,
): boolean {
  if (
    level === api ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.writable !== true ||
    descriptor.enumerable !== false ||
    descriptor.configurable !== true ||
    typeof descriptor.value !== 'function'
  ) {
    return false;
  }

  try {
    // A normal function prototype is an ordinary object whose prototype is
    // Object.prototype. A null-prototype object with a hand-installed function
    // is app data, not the marker created by that function. A class extending
    // null is the one legitimate exception; its source still identifies it as
    // a class without reading any app property.
    if (
      Object.getPrototypeOf(level) === null &&
      !Function.prototype.toString.call(descriptor.value).startsWith('class')
    ) {
      return false;
    }

    const prototype = Object.getOwnPropertyDescriptor(descriptor.value, 'prototype');
    return (
      prototype?.get === undefined &&
      prototype?.set === undefined &&
      prototype?.value === level &&
      prototype.enumerable === false &&
      prototype.configurable === false &&
      (prototype.writable === true || prototype.writable === false)
    );
  } catch {
    // A revoked proxy or a hostile descriptor trap is still an app-owned
    // constructor. Let the reserved-name guard report it as configuration.
    return false;
  }
}

function flattenApi(api: unknown): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  if (!api || typeof api !== 'object') return flat;

  const seen = new Set<object>();
  for (
    let level: object | null = api;
    level && level !== Object.prototype;
    level = Object.getPrototypeOf(level) as object | null
  ) {
    if (seen.has(level)) break;

    seen.add(level);

    for (const key of Object.getOwnPropertyNames(level)) {
      const descriptor = Object.getOwnPropertyDescriptor(level, key);
      // Every class prototype has an own constructor marker. It is an
      // implementation detail, but an app-owned constructor is a real API name
      // and must go through the same reserved-name guard as other built-ins.
      if (
        key === 'constructor' &&
        descriptor &&
        isAutomaticConstructorMarker(api, level, descriptor)
      ) {
        continue;
      }

      // Check reserved names before the own-property lookup because
      // `'__proto__' in flat` is true on a plain object.
      assertNotReservedApiName(key);
      if (Object.hasOwn(flat, key)) continue;

      const value = (api as Record<string, unknown>)[key];
      flat[key] = typeof value === 'function' ? value.bind(api) : value;
    }
  }

  return flat;
}
