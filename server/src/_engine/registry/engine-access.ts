/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CloseCodes } from '@wskit/core';
import { getInvocationScope } from '~/_engine/async-context.ts';
import { sendGap, sendProtocolMessage, sendReplay } from '~/_engine/runtime/wire.ts';
import { APP_HOOK_OWNER } from '~/intercept/intercept.ts';
import * as OutgoingRuntime from '~/outgoing/runtime.ts';
import type * as EngineAccessModule from '~/_engine/access.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { ScheduledCancelResult } from '~/scheduled/types.ts';

/** Callbacks engine-access can't build itself. Supplied by the facade. */
export interface EngineAccessDeps {
  /** Install the scheduled runtime if not already installed. */
  ensureScheduledRuntime(): void;
  /** Build a fresh task context for scheduled task handlers. */
  createTaskContext(): unknown;
  /** Queue one future scheduled task run. */
  scheduleTask(opts: { taskId: string; time: number; data: unknown }): void;
  /** Remove queued runs for one scheduled task id. */
  cancelScheduled(opts: {
    taskId: string;
    filter?: Record<string, unknown>;
  }): ScheduledCancelResult;
  /** Recompute the next scheduled callback from the queued-run table. */
  rescheduleAlarm(): void;
  /**
   * Build the context object for the connection whose dispatch is running right
   * now, or `undefined` when no connection is active (e.g. a fan-out broadcast
   * prepared once for many peers).
   */
  buildCurrentContext(): unknown;
  /**
   * Build the context object for one connection by id, or `undefined` when no
   * such connection is live. Unlike `buildCurrentContext`, this does not need a
   * dispatch to be running — a ping arrives outside one.
   */
  buildContextForConnection(connectionId: string): unknown;
  /** Send a server→client request frame through the outgoing pipeline. */
  sendServerRequest(
    connectionId: string,
    opts: {
      event: string;
      payload: unknown;
      correlationId: string;
      channel?: string;
      channelFamily?: string | null;
    },
  ): boolean;
  /** Broadcast one already-built protocol frame to every live member of a channel. */
  broadcastToChannel(opts: {
    channelName: string;
    channelFamily: string | null;
    event: string;
    payload: Record<string, unknown>;
  }): void;
  /** Count the live members currently in a channel. */
  channelMemberCount(channelName: string, channelFamily: string | null): number;
}

/**
 * Build the registration surface a primitive sees during `__setup`. Primitives
 * register hooks and read shared services through this object — they never
 * touch the engine class directly. One fresh object per primitive setup so
 * per-primitive guards (like the once-only `onUpgrade`) stay local.
 */
export function createEngineAccess(
  core: EngineCore,
  deps: EngineAccessDeps,
  scope?: { channelKey?: string },
): EngineAccessModule.EngineAccess {
  let onUpgradeCalled = false;
  return {
    storage: core.storage,
    timers: core.timers,
    installOnce: (key, install) => {
      if (core.installedFeatures.has(key)) return;
      core.installedFeatures.add(key);
      install();
    },
    onBoot: (handler) => {
      core.hooks.boot.push(handler);
    },
    onBootSchema: (handler) => {
      core.hooks.bootSchema.push(handler);
    },
    onPurgeUser: (handler) => {
      core.hooks.purgeUser.push(handler);
    },
    onIncoming: (handler) => {
      core.hooks.incoming.push(handler);
    },
    onAnswerFrame: (handler) => {
      core.hooks.answerFrame.push(handler);
    },
    sendServerRequest: (connectionId, opts) => deps.sendServerRequest(connectionId, opts),
    onOutgoing: (handler, owner) => {
      // The pipeline supplies the frame; ctx is resolved per-send from the
      // active connection, or undefined when none is in scope (broadcasts).
      // Note: this ctx is built fresh per send (new locals map) — it carries
      // stable identity/meta/routing but NOT per-dispatch `locals`/`inject` set
      // earlier in the same inbound dispatch. Outgoing hooks must not rely on
      // per-dispatch locals.
      core.hooks.outgoing.push({
        handler: (frame) => handler(deps.buildCurrentContext(), frame),
        owner: owner ?? APP_HOOK_OWNER,
      });
    },
    onWSKitStamp: (handler) => {
      core.hooks.wskitStamp.push(handler);
    },
    onBeforeSend: (handler) => {
      core.hooks.beforeSend.push(handler);
    },
    onAfterSend: (handler) => {
      core.hooks.afterSend.push(handler);
    },
    onConnectionActivity: (handler) => {
      core.hooks.activity.push(handler);
    },
    onMessageActivity: (handler) => {
      core.hooks.messageActivity.push(handler);
    },
    onInit: (handler) => {
      core.hooks.init.push(handler);
    },
    onConnect: (handler) => {
      core.hooks.connect.push(handler);
    },
    onDisconnect: (handler) => {
      core.hooks.disconnect.push(handler);
    },
    onShutdown: (handler) => {
      core.hooks.shutdown.push(handler);
    },
    onError: (handler) => {
      core.hooks.error.push(handler);
    },
    onUpgrade: (handler) => {
      if (onUpgradeCalled) {
        throw new Error(
          '[wskit] A primitive may only register one onUpgrade hook in its __setup. Compose multiple upgrade-time concerns inside one handler.',
        );
      }
      onUpgradeCalled = true;
      core.hooks.upgrade.push(handler);
    },
    setBuilderUpgradeHook: (handler) => {
      if (core.hooks.builderUpgrade !== undefined) {
        throw new Error(
          '[wskit] The builder onUpgrade hook is already set. Compose multiple upgrade-time concerns inside one .onUpgrade(...) handler.',
        );
      }
      core.hooks.builderUpgrade = handler;
    },
    onValidationError: (handler) => {
      core.hooks.validationError.push(handler);
    },
    onProtocolMessage: (event, handler) => {
      const existing = core.hooks.protocol.get(event) ?? [];
      existing.push(handler);
      core.hooks.protocol.set(event, existing);
    },
    onAlarm: (handler) => {
      core.hooks.alarm.push(handler);
    },
    onCheck: (handler, validator) => {
      pushChannelHook(core.hooks.check, scope?.channelKey, {
        hook: { handler, validator },
        hookName: 'onCheck',
      });
    },
    onRevalidate: (handler) => {
      pushChannelHook(core.hooks.revalidate, scope?.channelKey, {
        hook: handler,
        hookName: 'onRevalidate',
      });
    },
    onCommit: (handler) => {
      pushChannelHook(core.hooks.commit, scope?.channelKey, {
        hook: { handler },
        hookName: 'onCommit',
      });
    },
    onSubscribe: (handler) => {
      pushChannelHook(core.hooks.subscribe, scope?.channelKey, {
        hook: handler,
        hookName: 'onSubscribe',
      });
    },
    onUnsubscribe: (handler) => {
      pushChannelHook(core.hooks.unsubscribe, scope?.channelKey, {
        hook: handler,
        hookName: 'onUnsubscribe',
      });
    },
    onSessionEnd: (handler) => {
      pushChannelHook(core.hooks.sessionEnd, scope?.channelKey, {
        hook: handler,
        hookName: 'onSessionEnd',
      });
    },
    getScopeInfo: () => ({
      channelKey: scope?.channelKey,
    }),
    getReplayClaimedChannelKeys: () => core.compiled.replayClaimedChannelKeys,
    extendContext: (factory) => {
      core.hooks.contextExtenders.push(factory);
    },
    getInvocationScope: () => getInvocationScope(core.asyncContext),
    setHibernationEnabled: (enabled) => {
      core.hibernationEnabled = enabled;
    },
    getHibernationEnabled: () => core.hibernationEnabled,
    setReplayEnabled: (enabled) => {
      core.replayEnabled = enabled;
    },
    setSequencePersistent: (enabled) => {
      core.sequencePersistent = enabled;
    },
    setChannelPersistent: (channelKey, enabled) => {
      core.channelPersistenceOverrides.set(channelKey, enabled);
    },
    registerInboxChannel: (channelKey, options) => {
      core.inboxChannels.set(channelKey, options);
    },
    registerReadReceiptsChannel: (channelKey) => {
      core.readReceiptsChannels.add(channelKey);
    },
    registerPluginApi: (id, factory) => {
      if (core.pluginApiFactories.has(id)) {
        throw new Error(
          `[wskit] Plugin id '${id}' is registered more than once. Each plugin id must be unique.`,
        );
      }
      core.pluginApiFactories.set(id, factory);
    },
    getPluginApiFactory: (id) => core.pluginApiFactories.get(id),
    registerPluginLifecycle: (kind, pluginId, handler) => {
      const list = core.hooks.pluginLifecycle[kind];
      list.push({ pluginId, order: list.length, handler });
    },
    registerPluginUpgrade: (pluginId, handler) => {
      core.hooks.pluginUpgrade.push({ pluginId, handler });
    },
    registerTagGroups: (kind, groups) => {
      core.tagGroupsRegistered[kind] = true;
      for (const group of groups) {
        if (core.declaredTagGroups[kind].has(group.name)) {
          throw new Error(
            `[wskit] tagGroups.${kind} group '${group.name}' declared more than once in this contract.`,
          );
        }
        core.declaredTagGroups[kind].add(group.name);
        if (group.schema) core.tagGroupSchemas.set(`${kind}:${group.name}`, group.schema);
      }
    },
    isDurableMembershipPairPersistent: (channelName, channelFamily) =>
      core.isDurableMembershipPairPersistent(channelName, channelFamily),
    getLogger: () => core.logger,
    enableIncomingDedup: (cap) => {
      if (!Number.isFinite(cap) || cap <= 0) return;
      core.incomingDedupCap = Math.max(core.incomingDedupCap, Math.floor(cap));
    },
    registerErrorDefinitions: (defs) => {
      for (const def of defs) {
        core.declaredErrorCodes.add(def.code);
      }
    },
    refreshConnectionIdleTimeout: (connectionId, timeoutMs) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return;

      if (connection.keepaliveTimer !== undefined) {
        clearTimeout(connection.keepaliveTimer as ReturnType<typeof setTimeout>);
      }
      connection.keepaliveTimer = setTimeout(() => {
        connection.descriptor.close(CloseCodes.IDLE, 'Keepalive timeout');
      }, timeoutMs);
    },
    sendPing: (connectionId) => {
      core.connections.get(connectionId)?.descriptor.send('ping');
    },
    setConnectionLatency: (connectionId, latency, quality) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return;

      connection.latency = latency;
      connection.quality = quality;
    },
    getConnectionContext: (connectionId) => deps.buildContextForConnection(connectionId),
    onPing: (handler) => {
      core.hooks.ping.push(handler);
    },
    onPong: (handler) => {
      core.hooks.pong.push(handler);
    },
    onAppPing: (handler) => {
      core.hooks.appPing.push(handler);
    },
    onAppPong: (handler) => {
      core.hooks.appPong.push(handler);
    },
    onConnectionCleanup: (handler) => {
      core.hooks.connectionCleanup.push(handler);
    },
    getScheduledRuns: () => core.scheduledRuns,
    getScheduledDlq: () => core.scheduledDlq,
    scheduleTask: (taskId, time, data) => deps.scheduleTask({ taskId, time, data }),
    cancelScheduled: (taskId, filter) => deps.cancelScheduled({ taskId, filter }),
    getScheduledTask: (taskId) => core.compiled.scheduled.get(taskId),
    getScheduledTasks: () => core.compiled.scheduled.values(),
    createTaskContext: () => deps.createTaskContext(),
    sendReplay: (connectionId, options) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return;
      sendReplay(core, connection, options);
    },
    sendGap: (connectionId, options) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return;
      sendGap(core, connection, options);
    },
    assertReplaySendContract: (event, payload, routing) => {
      OutgoingRuntime.assertPayloadRecord(payload);
      if (!OutgoingRuntime.isDeclaredOutgoingEvent(core.compiled, event, routing)) {
        throw new Error(`[wskit] Outgoing event "${event}" was not declared in the active scope.`);
      }
    },
    rescheduleAlarm: () => deps.rescheduleAlarm(),
    generateId: (prefix) => core.generateId(prefix),
    waitUntil: (promise) => {
      core.waitUntilImpl(promise);
    },
    rawSend: (connectionId, event, payload) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return;
      sendProtocolMessage(core, connection, {
        event,
        payload: payload as Record<string, unknown>,
        wskit: {},
      });
    },
    sendProtocolFrame: (connectionId, options) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return;
      sendProtocolMessage(core, connection, {
        event: options.event,
        payload: options.payload as Record<string, unknown>,
        wskit: options.wskit ?? {},
      });
    },
    setStreamTrigger: (trigger) => {
      core.streamTrigger = trigger;
    },
    setActiveStreamOps: (buffer, cancel) => {
      core.streamNudgeBuffer = buffer;
      core.streamCancel = cancel;
    },
    setDurableStreamService: (service) => {
      core.durableStream = service;
    },
    setRequestDispatch: (dispatch) => {
      core.requestDispatch = dispatch;
    },
    setBuildTagsApi: (build) => {
      core.buildTagsApi = build;
    },
    setChannelMembershipService: (service) => {
      core.channelMembershipService = service;
    },
    setTagPersistenceService: (service) => {
      core.tagPersistenceService = service;
    },
    setScheduledService: (service) => {
      core.scheduledService = service;
    },
    setInterceptRuntime: (runIntercepts) => {
      core.runIntercepts = runIntercepts;
    },
    setChannelService: (service) => {
      core.channelService = service;
    },
    setChannelContext: (context) => {
      core.channelContext = context;
    },
    setInboxService: (service) => {
      core.inboxService = service;
    },
    setLastSeenService: (service) => {
      core.lastSeenService = service;
    },
    getLastSeenService: () => core.lastSeenService,
    addChannelHandleAugmenter: (augmenter) => {
      core.channelHandleAugmenters.push(augmenter);
    },
    isUserOnline: (userId) => {
      if (!userId) return false;
      const members = core.usersByKey.get(userId);
      return members !== undefined && members.size > 0;
    },
    getConnectionIdentity: (connectionId) => core.connections.get(connectionId)?.userId,
    broadcastToChannel: (opts) => deps.broadcastToChannel(opts),
    channelMemberCount: (channelName, channelFamily) =>
      deps.channelMemberCount(channelName, channelFamily),
    getInboxChannel: (channelKey) => core.inboxChannels.get(channelKey),

    receiptCursorCache: () => core.inboxReceiptCursors,
    hasReadReceiptsChannel: (channelKey) => core.readReceiptsChannels.has(channelKey),
  };
}

interface PushChannelHookOptions<T> {
  hook: T;
  hookName:
    | 'onCheck'
    | 'onRevalidate'
    | 'onCommit'
    | 'onSubscribe'
    | 'onUnsubscribe'
    | 'onSessionEnd';
}

/**
 * Add one hook to a channel-scoped registry. Throws if called outside
 * `channel(...)` since the hook needs a channel key to land under.
 */
function pushChannelHook<T>(
  hooks: Map<string, T[]>,
  channelKey: string | undefined,
  options: PushChannelHookOptions<T>,
): void {
  const { hook, hookName } = options;
  if (!channelKey) {
    throw new Error(`[wskit] ${hookName}() can only be registered inside channel(...).`);
  }

  const existing = hooks.get(channelKey) ?? [];
  existing.push(hook);
  hooks.set(channelKey, existing);
}
