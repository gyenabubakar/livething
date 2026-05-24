import { CloseCodes } from '@wskit/core';
import * as EngineContexts from '~/_engine/contexts/contexts.ts';
import { EngineCore } from '~/_engine/core.ts';
import * as EngineDeps from '~/_engine/engine.deps.ts';
import * as EngineConnectionRuntime from '~/_engine/runtime/connection.ts';
import * as EngineHibernation from '~/_engine/runtime/hibernation.ts';
import * as Initialize from '~/_engine/runtime/initialize.ts';
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

  // ─────── adapter configuration ───────

  /** Set the storage driver. */
  setStorage(storage: PublicApi.StorageProvider): void {
    this.core.setStorage(storage);
  }

  /** Set the env bindings exposed to every runtime context. */
  setEnv(env: Record<string, unknown>): void {
    this.core.setEnv(env);
  }

  /** Set the timer/alarm implementation. */
  setTimerProvider(timers: PublicApi.TimerProvider): void {
    this.core.setTimerProvider(timers);
  }

  /** Set the adapter-specific platform object. */
  setPlatform(platform: unknown): void {
    this.core.setPlatform(platform);
  }

  /**
   * Set the async-context capability used to track which connection's dispatch
   * is running. Required for a plugin's `getState()` to resolve correctly.
   */
  setAsyncContext(asyncContext: PublicApi.AsyncContext): void {
    this.core.setAsyncContext(asyncContext);
  }

  /** Set the adapter's `waitUntil` so tasks can outlive a single callback. */
  setWaitUntil(waitUntil: (promise: Promise<unknown>) => void): void {
    this.core.setWaitUntil(waitUntil);
  }

  /**
   * Set the logger. Call once during adapter setup. Falls back to `console.*`
   * if never called.
   */
  setLogger(logger: PublicApi.Logger): void {
    this.core.setLogger(logger);
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

  // ─────── adapter entry points ───────

  /** One-time startup: validate capabilities, install plugins, run boot + init hooks. */
  async initialize(): Promise<void> {
    await Initialize.initialize(this.core, EngineDeps.engineAccessDeps(this.core));
  }

  /** Accept a new websocket and return the callbacks the adapter uses to drive it. */
  accept(wsKey: unknown, descriptor: ConnectionDescriptor): ConnectionHandle {
    return EngineConnectionRuntime.acceptConnection(
      EngineDeps.connectionRuntime(this.core),
      wsKey,
      descriptor,
    );
  }

  /** Rebuild a connection handle for a websocket woken from hibernation. */
  handleHibernationWake(wsKey: unknown): ConnectionHandle {
    if (!this.usesHibernation()) {
      throw new Error('[wskit] hibernation() is not enabled for this handler.');
    }
    return EngineConnectionRuntime.wakeHibernatedConnection(
      EngineDeps.connectionRuntime(this.core),
      wsKey,
    );
  }

  /** Run the upgrade hook before the adapter commits to the handshake. */
  async handleUpgrade(request: Request): Promise<UpgradeDecision> {
    return EngineConnectionRuntime.handleUpgrade(
      {
        upgradeHooks: this.core.hooks.upgrade,
        builderUpgradeHook: this.core.hooks.builderUpgrade,
        upgradeHelpers: this.buildUpgradeHelpers(),
      },
      request,
    );
  }

  /** Shut down the engine and every connection or plugin it owns. */
  async handleShutdown(): Promise<void> {
    const core = this.core;
    return EngineConnectionRuntime.handleShutdown({
      connections: core.connections,
      timers: core.timers,
      shutdownHooks: core.hooks.shutdown,
      pluginRuntimes: core.pluginRuntimes,
      createShutdownContext: () => this.createShutdownContext(),
      cancelActiveStreamsForConnection: (connectionId) =>
        EngineConnectionRuntime.cancelActiveStreamsForConnection(
          { activeStreams: core.activeStreams },
          connectionId,
        ),
      handleConnectionClose: (connection) =>
        EngineDeps.handleConnectionClose(
          core,
          connection,
          CloseCodes.GOING_AWAY,
          'Server shutting down',
        ),
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

  /** Run alarm hooks after a timer wake-up. Scheduled tasks drain via this path. */
  async handleAlarm(): Promise<void> {
    await Initialize.handleAlarm(this.core, EngineDeps.engineAccessDeps(this.core));
  }

  /**
   * Drop persisted connection rows whose ids are not in `surviving`. Adapters
   * call this at boot with the sockets the platform still holds (empty set =
   * wipe all).
   */
  reconcileConnections(surviving: ReadonlySet<string>): void {
    EngineHibernation.reconcileConnections(this.core, surviving);
  }

  // ─────── internal helpers ───────

  /** Build the helper bag passed to every `onUpgrade` hook. @internal */
  private buildUpgradeHelpers(): LifecycleTypes.UpgradeHelpers {
    if (!this.core.usesTags()) return {};
    const isDeclared = (kind: 'ephemeral' | 'persistent', group: string) =>
      this.core.declaredTagGroups[kind].has(group);
    function buildRefFactory(kind: 'ephemeral' | 'persistent') {
      return (group: string) => {
        if (!isDeclared(kind, group)) {
          throw new Error(
            `[wskit] tag group '${group}' is not declared under tagGroups.${kind}. Add it to your contract's tagGroups config or check for a typo.`,
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
