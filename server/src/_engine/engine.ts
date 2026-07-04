import { CloseCodes } from '@wskit/core';
import * as EngineContexts from '~/_engine/contexts/contexts.ts';
import { EngineCore } from '~/_engine/core.ts';
import * as EngineDeps from '~/_engine/engine.deps.ts';
import * as EngineConnectionRuntime from '~/_engine/runtime/connection.ts';
import * as EngineHibernation from '~/_engine/runtime/hibernation.ts';
import * as Initialize from '~/_engine/runtime/initialize.ts';
import { withInvocationScope } from '~/_engine/runtime/invocation-scope.ts';
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as LifecycleTypes from '~/lifecycle/lifecycle.ts';
import type * as DefineServer from '~/server-definition.ts';

type ConnectionDescriptor = EngineAdapterTypes.ConnectionDescriptor;
type ConnectionHandle = EngineAdapterTypes.ConnectionHandle;
type UpgradeDecision = EngineAdapterTypes.UpgradeDecision;

export type {
  AdapterConfig,
  ConnectionDescriptor,
  ConnectionHandle,
  EngineOptions,
  UpgradeDecision,
} from '~/_adapters/types.ts';

/**
 * Runs one compiled server definition. Adapters call methods on this class;
 * state lives on {@link EngineCore} and behaviour in `_engine/runtime/*` and
 * `_engine/registry/*`.
 */
export class Engine {
  /** State container. Exposed for internal plugins that need direct field access. @internal */
  readonly core: EngineCore;

  constructor(handler: DefineServer.ServerDefinition, options: EngineAdapterTypes.EngineOptions) {
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

      alarmState: {
        get current() {
          return core.alarmHandle;
        },
        set current(value: unknown | null) {
          core.alarmHandle = value;
        },
      },

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
    for (const wsKey of sockets) {
      withInvocationScope(this.core, () => {
        EngineConnectionRuntime.wakeHibernatedConnection(runtime, wsKey);
      });
      const id = this.core.wsToConnectionId.get(wsKey);
      if (id) restored.add(id);
    }
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
    return EngineContexts.createShutdownContext({
      connections: this.core.connections,
      ...EngineDeps.commonDeps(this.core),
    });
  }
}
