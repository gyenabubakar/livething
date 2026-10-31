/* oxlint-disable @typescript-eslint/no-explicit-any */
import { CloseCodes } from '@livething/core';
import { getInvocationScope, withConnectionCall } from '~/_engine/async-context.ts';
import { assertPayloadRecord } from '~/_engine/runtime/json-guard.ts';
import { sendGap, sendProtocolMessage, sendReplay } from '~/_engine/runtime/wire.ts';
import { createChannelMembershipKey, hasChannelMembership } from '~/channel/runtime.ts';
import * as InboxRuntime from '~/inbox/runtime.ts';
import { APP_HOOK_OWNER } from '~/intercept/intercept.ts';
import * as OutgoingRuntime from '~/outgoing/runtime.ts';
import type * as EngineAccessModule from '~/_engine/access.ts';
import type { EngineCore } from '~/_engine/core.ts';

type OptsParameter = { taskId: string; time: number; data: unknown };
type OptsParameter2 = {
  taskId: string;
  filter?: Record<string, unknown>;
};
type OptsParameter3 = {
  event: string;
  payload: unknown;
  correlationId: string;
  channel?: string;
  channelFamily?: string | null;
};
type OptsParameter4 = {
  channelName: string;
  channelFamily: string | null;
  event: string;
  payload: Record<string, unknown>;
};
type CreateEngineAccessScopeParameter = { channelKey?: string };

/** Callbacks engine-access can't build itself. Supplied by the facade. */
export interface EngineAccessDeps {
  /** Install the scheduled runtime if not already installed. */
  ensureScheduledRuntime(): void;
  /** Queue one future scheduled task run. */
  scheduleTask(opts: OptsParameter): void;
  /** Remove queued runs for one scheduled task id. */
  cancelScheduled(opts: OptsParameter2): void;
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
  sendServerRequest(connectionId: string, opts: OptsParameter3): boolean;
  /** Send one server→client request to many connections, stamped once. */
  openServerRequestBroadcast(
    opts: EngineAccessModule.ServerRequestBroadcastOptions,
  ): EngineAccessModule.ServerRequestBroadcast;
  /** Broadcast one already-built protocol frame to every live member of a channel. */
  broadcastToChannel(opts: OptsParameter4): void;
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
  scope?: CreateEngineAccessScopeParameter,
): EngineAccessModule.EngineAccess {
  let onUpgradeCalled = false;
  return {
    storage: core.storage,
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
    openServerRequestBroadcast: (opts) => deps.openServerRequestBroadcast(opts),
    onOutgoing: (handler, owner) => {
      // The pipeline supplies the frame; ctx is resolved per-send from the
      // active connection in the async context, or undefined when none is set.
      // Note: this ctx is built fresh per send (new locals map) — it carries
      // stable identity/meta/routing but NOT per-dispatch `locals`/`inject` set
      // earlier in the same inbound dispatch. Outgoing hooks must not rely on
      // per-dispatch locals.
      core.hooks.outgoing.push({
        handler: (frame) => handler(deps.buildCurrentContext(), frame),
        owner: owner ?? APP_HOOK_OWNER,
      });
    },
    onLiveThingStamp: (handler) => {
      core.hooks.livethingStamp.push(handler);
    },
    onBeforeBroadcast: (handler) => {
      core.hooks.beforeBroadcast.push(handler);
    },
    onAfterBroadcast: (handler) => {
      core.hooks.afterBroadcast.push(handler);
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
          '[livething] A primitive may only register one onUpgrade hook in its __setup. Compose multiple upgrade-time concerns inside one handler.',
        );
      }

      onUpgradeCalled = true;
      core.hooks.upgrade.push(handler);
    },
    setBuilderUpgradeHook: (handler) => {
      if (core.hooks.builderUpgrade !== undefined) {
        throw new Error(
          '[livething] The `upgrade` hook is already set. Compose multiple upgrade-time concerns inside the one `upgrade` function of server({ ... }).',
        );
      }

      core.hooks.builderUpgrade = handler;
    },
    onProtocolMessage: (event, handler) => {
      const existing = core.hooks.protocol.get(event) ?? [];
      existing.push(handler);
      core.hooks.protocol.set(event, existing);
    },
    onAlarm: (handler) => {
      core.hooks.alarm.push(handler);
    },
    registerAlarmSource: (key, source) => {
      core.alarmSources.set(key, source);
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
    enableHibernation: () => {
      core.hibernationEnabled = true;
    },
    getHibernationEnabled: () => core.hibernationEnabled,
    setReplayEnabled: (enabled) => {
      core.replayEnabled = enabled;
    },
    setSequencePersistent: (enabled) => {
      core.sequencePersistent = enabled;
    },
    setDeliverySeqAllocator: (allocate) => {
      core.allocateDeliverySeq = allocate;
    },
    allocateDeliverySeq: () => {
      if (!core.allocateDeliverySeq) {
        throw new Error(
          '[livething] No delivery seq allocator. Add sequence() to server({ capabilities: [...] }).',
        );
      }

      return core.allocateDeliverySeq();
    },
    setChannelDurable: (channelKey, durable) => {
      core.channelDurabilityOverrides.set(channelKey, durable);
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
          `[livething] Plugin id '${id}' is registered more than once. Each plugin id must be unique.`,
        );
      }

      core.pluginApiFactories.set(id, factory);
    },
    getPluginApiFactory: (id) => core.pluginApiFactories.get(id),
    registerPluginLifecycle: (kind, pluginId, handler) => {
      core.hooks.pluginLifecycle[kind].push({ pluginId, handler });
    },
    registerPluginUpgrade: (pluginId, handler, baseId) => {
      core.hooks.pluginUpgrade.push({ pluginId, handler, baseId });
    },
    registerTagGroups: (kind, groups) => {
      core.tagGroupsRegistered[kind] = true;
      for (const group of groups) {
        if (core.declaredTagGroups[kind].has(group.name)) {
          throw new Error(
            `[livething] tagGroups.${kind} group '${group.name}' declared more than once in this contract.`,
          );
        }

        core.declaredTagGroups[kind].add(group.name);
        if (group.schema) core.tagGroupSchemas.set(`${kind}:${group.name}`, group.schema);
      }
    },
    isDurableMembershipPairDurable: (channelName, channelFamily) =>
      core.isDurableMembershipPairDurable(channelName, channelFamily),
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
      const connection = core.connections.get(connectionId);
      if (!connection) return false;

      return connection.descriptor.send('ping') !== false;
    },
    setConnectionLatency: (connectionId, latency, quality) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return;

      connection.latency = latency;
      connection.quality = quality;
    },
    getConnectionContext: (connectionId) => deps.buildContextForConnection(connectionId),
    runInConnectionCall: (connectionId, ctx, fn) =>
      withConnectionCall(
        core.asyncContext,
        { kind: 'connection', getCtx: () => ctx, connectionId },
        fn,
      ),
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
    scheduleTask: (taskId, time, data) => deps.scheduleTask({ taskId, time, data }),
    cancelScheduled: (taskId, filter) => deps.cancelScheduled({ taskId, filter }),
    getScheduledTask: (taskId) => core.compiled.scheduled.get(taskId),
    getScheduledTasks: () => core.compiled.scheduled.values(),
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
      // The shape only. A payload that fails to serialize (a BigInt, a Date) becomes a sanitized
      // __error__ for that row in sendReplay, so the replay loop keeps going.
      assertPayloadRecord(event, payload);
      if (!OutgoingRuntime.isDeclaredOutgoingEvent(core.compiled, event, routing)) {
        throw new Error(
          `[livething] Outgoing event "${event}" was not declared in the active scope.`,
        );
      }
    },
    rescheduleAlarm: () => deps.rescheduleAlarm(),
    generateId: (prefix) => core.generateId(prefix),
    rawSend: (connectionId, event, payload) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return;

      sendProtocolMessage(core, connection, {
        event,
        payload: payload as Record<string, unknown>,
        livething: {},
      });
    },
    sendProtocolFrame: (connectionId, options) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return;

      sendProtocolMessage(core, connection, {
        event: options.event,
        payload: options.payload as Record<string, unknown>,
        livething: options.livething ?? {},
      });
    },
    setStreamTrigger: (trigger) => {
      core.streamTrigger = trigger;
    },
    setActiveStreamOps: (buffer, cancel, channelLeave) => {
      core.streamNudgeBuffer = buffer;
      core.streamCancel = cancel;
      core.streamChannelLeave = channelLeave;
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
    userConnectionIdsInChannel: (userId, channelName, channelFamily) => {
      const members = core.channelMembers.get(
        createChannelMembershipKey(channelName, channelFamily),
      );
      return [...(members ?? [])]
        .filter((connection) => connection.userId === userId)
        .map((connection) => connection.id);
    },
    isConnectionInChannel: (connectionId, channelName, channelFamily) => {
      const connection = core.connections.get(connectionId);
      return connection !== undefined
        ? hasChannelMembership(connection, channelName, channelFamily)
        : false;
    },
    getConnectionIdentity: (connectionId) => core.connections.get(connectionId)?.userId,
    isUserPurging: (userId) => core.isUserPurging(userId),
    broadcastToChannel: (opts) => deps.broadcastToChannel(opts),
    channelMemberCount: (channelName, channelFamily) =>
      deps.channelMemberCount(channelName, channelFamily),
    getInboxChannel: (channelKey) => core.inboxChannels.get(channelKey),
    getInboxChannelScopes: () => ({
      staticNames: [...core.inboxChannels.keys()].filter((key) => core.compiled.channels.has(key)),
      familyKeys: [...core.inboxChannels.keys()].filter((key) =>
        core.compiled.channelFamilies.has(key),
      ),
    }),
    invalidateInboxMemberCount: (channelName, channelFamily, userId) => {
      core.inboxMemberCounts.delete(
        InboxRuntime.memberCountKey(channelName, channelFamily, userId),
      );
    },

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
    throw new Error(`[livething] ${hookName}() can only be registered inside channel(...).`);
  }

  const existing = hooks.get(channelKey) ?? [];
  existing.push(hook);
  hooks.set(channelKey, existing);
}
