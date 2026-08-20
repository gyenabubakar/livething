import { CloseCodes, WSKitConfigError } from '@wskit/core';
import { EngineCore } from '~/_engine/core.ts';
import * as EngineDeps from '~/_engine/engine.deps.ts';
import * as EngineConnectionRuntime from '~/_engine/runtime/connection.ts';
import * as EngineHibernation from '~/_engine/runtime/hibernation.ts';
import * as Initialize from '~/_engine/runtime/initialize.ts';
import { withInvocationScope } from '~/_engine/runtime/invocation-scope.ts';
import * as EnginePurgeUser from '~/_engine/runtime/purge-user.ts';
import { createAdminContext, RESERVED_ADMIN_API_NAMES } from '~/admin/context.ts';
import { createShutdownContext } from '~/lifecycle/context.ts';
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as LifecycleTypes from '~/lifecycle/lifecycle.ts';
import type { Primitive } from '~/primitive.ts';
import type * as DefineServer from '~/server-definition.ts';

type ConnectionDescriptor = EngineAdapterTypes.ConnectionDescriptor;
type ConnectionHandle = EngineAdapterTypes.ConnectionHandle;
type UpgradeDecision = EngineAdapterTypes.UpgradeDecision;

/**
 * Runs one compiled server definition. Adapters call methods on this class;
 * state lives on {@link EngineCore} and behaviour in `_engine/runtime/*` and
 * `_engine/registry/*`.
 *
 * @template TApi The `api` factory's return type, carried from the handler so
 *   {@link Engine.admin} stays typed all the way out to the adapter.
 */
export class Engine<TApi = unknown> {
  /** State container. Exposed for internal plugins that need direct field access. @internal */
  readonly core: EngineCore;

  constructor(
    handler: DefineServer.ServerDefinition<
      readonly Primitive[],
      DefineServer.ServerContract,
      unknown,
      TApi
    >,
    options: EngineAdapterTypes.EngineOptions,
  ) {
    this.core = new EngineCore(handler, options);
  }

  /** Set the engine instance id. Only adapters running with a broker call this. */
  setInstanceId(id: string): void {
    this.core.setInstanceId(id);
  }

  /** @internal */
  getLogger(): PublicApi.Logger {
    return this.core.logger;
  }

  /** True if the handler opted into hibernation. */
  usesHibernation(): boolean {
    return this.core.hibernationEnabled;
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
  accept(wsKey: unknown, descriptor: ConnectionDescriptor): ConnectionHandle {
    const handle = EngineConnectionRuntime.acceptConnection(
      EngineDeps.connectionRuntime(this.core),
      wsKey,
      descriptor,
    );
    return this.wrapHandle(handle);
  }

  /** Rebuild a connection handle for a websocket woken from hibernation. */
  handleHibernationWake(wsKey: unknown): ConnectionHandle {
    if (!this.usesHibernation()) {
      throw new Error(
        '[wskit] hibernation is not enabled for this handler. Set `hibernation: true` on the contract.',
      );
    }
    const handle = EngineConnectionRuntime.wakeHibernatedConnection(
      EngineDeps.connectionRuntime(this.core),
      wsKey,
    );
    return this.wrapHandle(handle);
  }

  // Wrap each callback so any state changes the handler triggers collect into
  // one row write at the end of the handler instead of one row write per
  // change. Only covers what runs (and is awaited) inside the callback —
  // work scheduled via waitUntil, a setTimeout, or a paused generator runs
  // after the callback returns, outside the scope, and writes right away.
  private wrapHandle(handle: ConnectionHandle): ConnectionHandle {
    return {
      handleMessage: (data) => withInvocationScope(this.core, () => handle.handleMessage(data)),
      handleClose: (code, reason) =>
        withInvocationScope(this.core, () => handle.handleClose(code, reason)),
      handleError: (error) => withInvocationScope(this.core, () => handle.handleError(error)),
    };
  }

  /** Run the upgrade hook before the adapter commits to the handshake. */
  async handleUpgrade(request: Request): Promise<UpgradeDecision> {
    return EngineConnectionRuntime.handleUpgrade(
      {
        upgradeHooks: this.core.hooks.upgrade,
        pluginUpgradeHooks: this.core.hooks.pluginUpgrade,
        builderUpgradeHook: this.core.hooks.builderUpgrade,
        upgradeHelpers: this.buildUpgradeHelpers(),
        isTagGroupDeclared: (kind, group) => this.core.isTagGroupDeclared(kind, group),
      },
      request,
    );
  }

  /** Shut down the engine and every connection or plugin it owns. */
  async handleShutdown(): Promise<void> {
    const core = this.core;
    return EngineConnectionRuntime.handleShutdown({
      connections: core.connections,
      activeStreams: core.activeStreams,
      shutdownHooks: core.hooks.shutdown,
      pluginShutdownHooks: core.hooks.pluginLifecycle.shutdown,

      createShutdownContext: () => this.createShutdownContext(),

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
    });
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
   * pruned. A no-op without hibernation.
   */
  restoreHibernatedConnections(sockets: Iterable<unknown>): void {
    if (!this.usesHibernation()) return;
    const runtime = EngineDeps.connectionRuntime(this.core);
    const restored = new Set<string>();
    EngineHibernation.withPreloadedConnectionRows(this.core, () => {
      for (const wsKey of sockets) {
        withInvocationScope(this.core, () => {
          EngineConnectionRuntime.wakeHibernatedConnection(runtime, wsKey);
        });
        const id = this.core.wsToConnectionId.get(wsKey);
        if (id) restored.add(id);
      }
    });
    EngineHibernation.reconcileConnections(this.core, restored);
  }

  /** Build the helper bag passed to every `onUpgrade` hook. @internal */
  private buildUpgradeHelpers(): LifecycleTypes.UpgradeHelpers {
    if (!this.core.usesTags()) return {};

    const isDeclared = (kind: 'ephemeral' | 'persistent', group: string) =>
      this.core.declaredTagGroups[kind].has(group);

    function buildRefFactory(kind: 'ephemeral' | 'persistent') {
      return (group: string) => {
        if (!isDeclared(kind, group)) {
          throw new Error(
            `[wskit] tag group '${group}' is not declared under tags (${kind}). Add it to your contract's tags: builder or check for a typo.`,
          );
        }

        return {
          ref: (key: string): PublicApi.TagRef => ({
            __wskit: 'tag-ref',
            kind,
            group,
            key,
          }),
        };
      };
    }

    return {
      tags: {
        ephemeral: buildRefFactory('ephemeral'),
        persistent: buildRefFactory('persistent'),
      },
    };
  }

  /** @internal */
  private createShutdownContext() {
    return createShutdownContext({
      connections: this.core.connections,
      usersByKey: this.core.usersByKey,
      ...EngineDeps.commonDeps(this.core),
    });
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
  admin(): PublicApi.AdminContext<Record<string, unknown>, Record<string, unknown>, unknown> &
    TApi {
    const core = this.core;
    const ctx = createAdminContext({
      connections: core.connections,
      usersByKey: core.usersByKey,
      ...EngineDeps.commonDeps(core),
      purgeUser: (userId, options) => EnginePurgeUser.purgeUser(core, userId, options),
    });
    const devApi = core.adminApiFactory ? core.adminApiFactory(ctx) : {};
    // Copy descriptors rather than spreading: `connectionCount` is a getter and
    // must stay live, and the built-ins have to land after the dev api to win.
    const surface = flattenApi(devApi);
    Object.defineProperties(surface, Object.getOwnPropertyDescriptors(ctx));
    return surface as PublicApi.AdminContext<
      Record<string, unknown>,
      Record<string, unknown>,
      unknown
    > &
      TApi;
  }
}

/**
 * Flatten an `api` factory's result into own properties.
 *
 * An api may be a class instance, whose methods live on its prototype. Spread
 * and `Object.entries` only see own properties, so those methods would be lost
 * before an adapter ever looked for them. Methods keep their original receiver,
 * so one that reads `this` (or a private field) still works after the move.
 */
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
  const reason =
    key === 'then'
      ? `'then' makes any object a thenable, so \`await service.admin()\` calls it ` +
        `instead of resolving. The await never settles.`
      : `'${key}' is already inherited by the plain object the admin surface is ` +
        `built on. A method by this name cannot be placed on the surface — the ` +
        `inherited one is already there — and would go missing without explanation.`;
  throw new WSKitConfigError(
    `[wskit] assemble({ api }) declared the reserved method name '${key}'. ${reason} Rename it.`,
  );
}

function flattenApi(api: unknown): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  if (!api || typeof api !== 'object') return flat;

  for (
    let level: object | null = api;
    level && level !== Object.prototype;
    level = Object.getPrototypeOf(level) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(level)) {
      // Every class prototype has an inherited constructor property. It is an
      // implementation detail, but an app-owned constructor is a real API name
      // and must go through the same reserved-name guard as other built-ins.
      if (key === 'constructor' && level !== api) continue;
      // Before the `in flat` guard: `'__proto__' in flat` is true on any plain
      // object, so a method by that name would be skipped silently instead of
      // reported.
      assertNotReservedApiName(key);
      if (Object.hasOwn(flat, key)) continue;
      const value = (api as Record<string, unknown>)[key];
      flat[key] = typeof value === 'function' ? value.bind(api) : value;
    }
  }
  return flat;
}
