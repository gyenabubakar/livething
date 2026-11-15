/* oxlint-disable @typescript-eslint/no-explicit-any */
import { rescheduleAlarm as rescheduleEngineAlarm } from '~/_engine/alarm.ts';
import { createConnectionlessContext } from '~/_engine/contexts/connectionless.ts';
import * as EngineContexts from '~/_engine/contexts/contexts.ts';
import { createLazyStorageView } from '~/_engine/contexts/lazy-storage.ts';
import * as EngineConnectionRuntime from '~/_engine/runtime/connection.ts';
import * as EngineErrorRuntime from '~/_engine/runtime/error.ts';
import * as EngineHibernation from '~/_engine/runtime/hibernation.ts';
import * as EngineMessageRuntime from '~/_engine/runtime/messages.ts';
import * as EnginePurgeUser from '~/_engine/runtime/purge-user.ts';
import { assertLocalRef } from '~/_engine/runtime/refs.ts';
import { sendProtocolMessage, sendReplay } from '~/_engine/runtime/wire.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import { binaryBytesRoom } from '~/incoming/incoming.ts';
import * as OutgoingRuntime from '~/outgoing/runtime.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { EngineAccessDeps } from '~/_engine/registry/engine-access.ts';
import type { InboxService } from '~/_engine/runtime/feature-slots.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type { MembershipInsert } from '~/channel/storage.ts';
import type * as PublicApi from '~/context.ts';
import type * as ErrorsRuntime from '~/errors/runtime.ts';
import type { StopChannelStreamsOptions } from '~/stream/runtime.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type ResolvedChannel = EngineRuntimeTypes.ResolvedChannel;
type RoutingTarget = EngineRuntimeTypes.RoutingTarget;
type BroadcastOptions = PublicApi.BroadcastOptions;

interface PipelineOptions {
  routing: RoutingTarget | undefined;
  event: string;
  payload: unknown;
}

type InboxFanOutOptions = Parameters<InboxService['fanOut']>[1];
type InboxMessage = Parameters<InboxService['canStore']>[1];

interface PersistAttachmentOptions {
  force?: boolean;
}

interface ProtocolMessageOptions {
  event: string;
  payload: Record<string, unknown>;
  livething: Record<string, unknown>;
}

type RuntimeErrorOptions = Pick<
  ErrorsRuntime.SendRuntimeErrorOptions,
  'error' | 'event' | 'routing' | 'deliver'
>;

interface ReplayWire {
  deliverySeq: number;
  messageId: string;
  channel?: string;
}

interface ReplaySendOptions {
  channelName: string | null;
  channelFamily: string | null;
  event: string;
  payload: unknown;
  wire: ReplayWire;
}

interface BroadcastConnectionsOptions {
  event: string;
  payload: unknown;
  options?: BroadcastOptions;
  excludeConnectionId?: string;
}

// Each dependency bag closes over `core` and is otherwise constant for the
// engine's life — build it once per core and reuse it, rather than rebuilding
// the whole tree on every message and every send.
interface DepsMemo {
  common?: ReturnType<typeof buildCommonDeps>;
  outgoing?: ReturnType<typeof buildOutgoingRuntime>;
  member?: ReturnType<typeof buildMemberRuntime>;
  channel?: ReturnType<typeof buildChannelRuntime>;
  dispatch?: ReturnType<typeof buildDispatchRuntime>;
  connection?: ReturnType<typeof buildConnectionRuntime>;
  ctxDeps?: EngineContextTypes.BuildConnectionContextDeps;
}

const depsMemo = new WeakMap<EngineCore, DepsMemo>();

function depsMemoFor(core: EngineCore): DepsMemo {
  let memo = depsMemo.get(core);
  if (memo === undefined) {
    memo = {};
    depsMemo.set(core, memo);
  }

  return memo;
}

/** The constant dep bag passed to `EngineContexts.buildConnectionContext`. */
function ctxDeps(core: EngineCore): EngineContextTypes.BuildConnectionContextDeps {
  return (depsMemoFor(core).ctxDeps ??= {
    compiled: core.compiled,
    connections: core.connections,
    usersByKey: core.usersByKey,
    tagMembers: core.tagMembers,
    buildTagsApi: core.buildTagsApi,
    channelContext: core.channelContext,
    ...commonDeps(core),
  });
}

/** Closure that builds a live-connection context. Used by error + dispatch helpers. */
function buildConnectionContext(core: EngineCore) {
  return (connection: RuntimeConnection, scope?: ResolvedChannel) =>
    EngineContexts.buildConnectionContext(ctxDeps(core), connection, scope);
}

/** Shared dep bag for the init, connectionless, and connection context builders. */
export function commonDeps(core: EngineCore): EngineContextTypes.ContextCommonDeps {
  return (depsMemoFor(core).common ??= buildCommonDeps(core));
}

/** The context `onShutdown` hooks, scheduled task bodies, and the admin surface receive. */
export function connectionlessContext(
  core: EngineCore,
): PublicApi.ConnectionlessContext<Record<string, unknown>, unknown> {
  return createConnectionlessContext({
    connections: core.connections,
    usersByKey: core.usersByKey,
    ...commonDeps(core),
    purgeUser: (userId, options) => EnginePurgeUser.purgeUser(core, userId, options),
  });
}

/** Factory form of {@link connectionlessContext}, handed to the scheduled service. */
function connectionlessContextFactory(core: EngineCore): () => unknown {
  return () => connectionlessContext(core);
}

function buildCommonDeps(core: EngineCore): EngineContextTypes.ContextCommonDeps {
  let storageView: ReturnType<typeof createLazyStorageView> | undefined;
  return {
    logger: core.logger,
    platform: core.platform,
    getStorage: () => core.storage,
    isUserPurging: (userId) => core.isUserPurging(userId),
    getStorageView: () =>
      (storageView ??= createLazyStorageView(core.options.storage, core.userTransactions)),
    scheduleTask: (taskId, time, data) =>
      core.scheduledService?.scheduleTask(core, connectionlessContextFactory(core), {
        taskId,
        time,
        data,
      }),
    cancelScheduled: (taskId, filter) =>
      core.scheduledService?.cancelScheduled(core, connectionlessContextFactory(core), {
        taskId,
        filter,
      }),
    broadcastToConnections: (connections, opts) => {
      OutgoingRuntime.broadcastToConnections(outgoingRuntime(core), connections, opts);
    },
    sendThroughPipeline: (connection, opts) => {
      return OutgoingRuntime.sendThroughPipeline(outgoingRuntime(core), connection, opts);
    },
    sendToConnections: (connections, opts) =>
      OutgoingRuntime.sendToConnections(outgoingRuntime(core), connections, opts),
    broadcastToUser: (connections, opts) =>
      OutgoingRuntime.broadcastToUser(outgoingRuntime(core), connections, opts),
    broadcastToChannel: (opts) => {
      OutgoingRuntime.broadcastToChannel(memberRuntime(core), opts);
    },
    broadcastToChannelRecipient: (opts) => {
      if (opts.to.__livething === 'connection-ref' || opts.to.__livething === 'user-ref') {
        assertLocalRef(opts.to, core.engineInstanceId, 'channelHandle.broadcastTo(to, ...)');
      }

      const targets = ChannelPrimitive.resolveChannelRecipients(core.channelMembers, {
        channelName: opts.channelName,
        channelFamily: opts.channelFamily,
        to: opts.to,
      });
      // A user is addressed as one audience, so replay can hand the frame to
      // that user's next connection. Connection, tag, and group recipients are
      // sends that replay never records.
      if (opts.to.__livething === 'user-ref') {
        return OutgoingRuntime.broadcastToUser(outgoingRuntime(core), targets, {
          userId: opts.to.id,
          event: opts.event,
          payload: opts.payload,
          channelName: opts.channelName,
          channelFamily: opts.channelFamily,
        });
      }

      return OutgoingRuntime.sendToConnections(outgoingRuntime(core), targets, {
        routing: { channel: opts.channelName, channelFamily: opts.channelFamily },
        event: opts.event,
        payload: opts.payload,
        target: OutgoingRuntime.outgoingTargetOf(opts.to),
      });
    },
    getChannelMembers: (channelName, channelFamily) =>
      core.channelService?.getChannelMembers(core, channelName, channelFamily) ?? [],
    kickChannelMembers: (opts) => {
      if (opts.target.__livething === 'user-ref') {
        assertLocalRef(opts.target, core.engineInstanceId, 'channelHandle.kick(target)');
      }

      return core.channelService?.kickChannelMembers(core, opts) ?? Promise.resolve();
    },
    subscribeConnectionAsServer: (ref, opts) =>
      core.channelService?.subscribeFromServer(core, ref, opts) ?? Promise.resolve(),
    resolveChannel: (target) => {
      if (typeof target === 'string') {
        const compiledChannel = core.compiled.channels.get(target);
        if (!compiledChannel) return undefined;

        return { channelName: target, channelFamily: null, params: {} };
      }

      const family = core.compiled.channelFamilies.get(target.family);
      if (!family) return undefined;

      if (!ChannelPrimitive.matchesFamilyPattern(family.pattern, target.name)) return undefined;

      return {
        channelName: target.name,
        channelFamily: target.family,
        params: ChannelPrimitive.matchScopeParams(family.pattern, target.name),
      };
    },
    sendReplay: (connection, opts) => {
      sendReplay(core, connection, opts);
    },
    sendProtocolMessage: (connection, opts) => {
      sendProtocolMessage(core, connection, opts);
    },
    persistAttachment: (connection) => EngineHibernation.persistAttachment(core, connection),
    toConnectionInfo: (connection) =>
      EngineContexts.toConnectionInfo(connection, core.engineInstanceId, {
        lastSeenAt: core.lastSeenService
          ? (identity) => core.lastSeenService!.at(identity)
          : undefined,
      }),
    contextExtenders: core.hooks.contextExtenders,
    instanceId: core.engineInstanceId,
    usesTags: core.usesTags(),
    isTagGroupDeclared: (kind, group) => core.isTagGroupDeclared(kind, group),
    getTagGroupSchema: (kind, group) => core.getTagGroupSchema(kind, group),
    channelHandleAugmenters: core.channelHandleAugmenters,
    // Read when used: `Engine` builds the admin surface before the capabilities are set up.
    get addBinarySenders() {
      return core.binaryService?.addSenders;
    },
  };
}

/** Dep bag for helpers that only touch outgoing messages. */
export function outgoingRuntime(core: EngineCore) {
  return (depsMemoFor(core).outgoing ??= buildOutgoingRuntime(core));
}

function buildOutgoingRuntime(core: EngineCore) {
  return {
    compiled: core.compiled,
    outgoingHooks: core.hooks.outgoing,
    livethingStampHooks: core.hooks.livethingStamp,
    beforeBroadcastHooks: core.hooks.beforeBroadcast,
    afterBroadcastHooks: core.hooks.afterBroadcast,
    trackBackgroundWork: (work: Promise<void>) => core.trackBackgroundWork(work),
    logger: core.logger,
    generateId: (prefix?: string) => core.generateId(prefix),
    activityHooks: core.hooks.activity,
    messageActivityHooks: core.hooks.messageActivity,
    pingHooks: core.hooks.ping,
    pongHooks: core.hooks.pong,
    pluginPingHooks: core.hooks.pluginLifecycle.ping,
    pluginPongHooks: core.hooks.pluginLifecycle.pong,
    appPingHooks: core.hooks.appPing,
    appPongHooks: core.hooks.appPong,
  };
}

/** Dep bag for helpers that also need live connections and membership data. */
export function memberRuntime(core: EngineCore) {
  return (depsMemoFor(core).member ??= buildMemberRuntime(core));
}

function buildMemberRuntime(core: EngineCore) {
  return {
    ...outgoingRuntime(core),
    asyncContext: core.asyncContext,
    connections: core.connections,
    channelMembers: core.channelMembers,
    toConnectionInfo: (connection: RuntimeConnection) =>
      EngineContexts.toConnectionInfo(connection, core.engineInstanceId, {
        lastSeenAt: core.lastSeenService
          ? (identity) => core.lastSeenService!.at(identity)
          : undefined,
      }),
    sendThroughPipeline: (connection: RuntimeConnection, opts: PipelineOptions) =>
      OutgoingRuntime.sendThroughPipeline(outgoingRuntime(core), connection, opts),
    openSharedSend: (opts: OutgoingRuntime.SharedSendOptions) =>
      OutgoingRuntime.openSharedSend(outgoingRuntime(core), opts),
    inboxFanOut: core.inboxService
      ? (opts: InboxFanOutOptions) => core.inboxService?.fanOut(core, opts)
      : undefined,
    inboxCanStore: core.inboxService
      ? (message: InboxMessage) => core.inboxService?.canStore(core, message) ?? true
      : undefined,
  };
}

/** Dep bag for channel subscribe/unsubscribe helpers. */
export function channelRuntime(core: EngineCore) {
  return (depsMemoFor(core).channel ??= buildChannelRuntime(core));
}

function buildChannelRuntime(core: EngineCore) {
  const buildCtx = buildConnectionContext(core);
  return {
    ...memberRuntime(core),

    checkHooks: core.hooks.check,
    revalidateHooks: core.hooks.revalidate,
    commitHooks: core.hooks.commit,
    subscribeHooks: core.hooks.subscribe,
    unsubscribeHooks: core.hooks.unsubscribe,
    sessionEndHooks: core.hooks.sessionEnd,
    asyncContext: core.asyncContext,

    broadcastToChannel: (opts: ChannelPrimitive.BroadcastToChannelOptions) => {
      OutgoingRuntime.broadcastToChannel(dispatchRuntime(core), opts);
    },

    buildConnectionContext: buildCtx,

    persistAttachment: (connection: RuntimeConnection, options?: PersistAttachmentOptions) =>
      EngineHibernation.persistAttachment(core, connection, options),

    sendProtocolMessage: (connection: RuntimeConnection, opts: ProtocolMessageOptions) =>
      sendProtocolMessage(core, connection, opts),

    allocateDeliverySeq: () => core.allocateDeliverySeq?.(),

    handleRuntimeError: (connection: RuntimeConnection, opts: RuntimeErrorOptions) =>
      EngineErrorRuntime.handleRuntimeError(
        { core, buildConnectionContext: buildCtx },
        connection,
        opts,
      ),

    isChannelDurable: (channelKey: string) => core.isChannelDurable(channelKey),

    persistMembership: (row: MembershipInsert) => {
      if (!core.isUserPurging(row.userId)) {
        core.channelMembershipService?.persistMembership(core, row);
      }
    },

    deleteDurableMembership: (userId: string, channelName: string, channelFamily: string | null) =>
      core.channelMembershipService?.deleteDurableMembership(core, {
        userId,
        channelName,
        channelFamily,
      }),

    getDurableMembership: (userId: string, channelName: string, channelFamily: string | null) =>
      core.channelMembershipService?.getDurableMembership(core, {
        userId,
        channelName,
        channelFamily,
      }),

    listDurableMembers: (channelName: string, channelFamily: string | null) =>
      core.channelMembershipService?.listDurableMembers(core, channelName, channelFamily) ?? [],

    clearInbox: (userId: string, channelName: string, channelFamily: string | null) =>
      core.inboxService?.clearChannel(core, { userId, channelName, channelFamily }),

    isInboxChannel: (channelName: string, channelFamily: string | null) =>
      core.inboxChannels.has(channelFamily ?? channelName),

    isReadReceiptsChannel: (channelName: string, channelFamily: string | null) =>
      core.readReceiptsChannels.has(channelFamily ?? channelName),

    stopChannelStreams: (connection: RuntimeConnection, opts: StopChannelStreamsOptions) =>
      core.streamChannelLeave?.(dispatchRuntime(core), connection, opts) ?? Promise.resolve(),

    logger: core.logger,
  };
}

/** Dep bag for inbound text-message dispatch. */
export function dispatchRuntime(core: EngineCore) {
  return (depsMemoFor(core).dispatch ??= buildDispatchRuntime(core));
}

/** The default `maxBytes` of a binary handler, or none when the receive limit is too small. */
function defaultBinaryMaxBytes(receiveBytes: number): number | undefined {
  const room = binaryBytesRoom(receiveBytes);
  return room > 0 ? room : undefined;
}

function buildDispatchRuntime(core: EngineCore) {
  const buildCtx = buildConnectionContext(core);
  return {
    ...memberRuntime(core),

    logger: core.logger,
    activeStreams: core.activeStreams,
    sql: core.storage.sql,
    messageLimits: core.messageLimits,
    maxPendingBytes: 2 * core.messageLimits.receiveBytes,
    defaultBinaryMaxBytes: defaultBinaryMaxBytes(core.messageLimits.receiveBytes),
    protocolHandlers: core.hooks.protocol,
    incomingHooks: core.hooks.incoming,
    answerFrameHooks: core.hooks.answerFrame,
    answerAwaitedHooks: core.hooks.answerAwaited,
    errorHooks: core.hooks.error,
    declaredErrorCodes: core.declaredErrorCodes,
    incomingDedupCap: core.incomingDedupCap,

    buildConnectionContext: buildCtx,

    sendProtocolMessage: (connection: RuntimeConnection, opts: ProtocolMessageOptions) =>
      sendProtocolMessage(core, connection, opts),

    sendReplay: (connection: RuntimeConnection, opts: ReplaySendOptions) =>
      sendReplay(core, connection, opts),

    persistAttachment: (connection: RuntimeConnection, options?: PersistAttachmentOptions) =>
      EngineHibernation.persistAttachment(core, connection, options),

    handleRuntimeError: (connection: RuntimeConnection, opts: RuntimeErrorOptions) =>
      EngineErrorRuntime.handleRuntimeError(
        { core, buildConnectionContext: buildCtx },
        connection,
        opts,
      ),

    broadcastToConnections: (
      connections: Iterable<RuntimeConnection>,
      opts: BroadcastConnectionsOptions,
    ) => OutgoingRuntime.broadcastToConnections(outgoingRuntime(core), connections, opts),

    handleSubscribe: (connection: RuntimeConnection, frame: Protocol.SubscribeFrame) =>
      core.channelService?.handleSubscribe(core, connection, frame) ?? Promise.resolve(),
    handleUnsubscribe: (connection: RuntimeConnection, frame: Protocol.UnsubscribeFrame) =>
      core.channelService?.handleUnsubscribe(core, connection, frame) ?? Promise.resolve(),
    durableStreamSchemaReady: false,

    get streamTrigger() {
      return core.streamTrigger;
    },
    get streamNudgeBuffer() {
      return core.streamNudgeBuffer;
    },
    get streamCancel() {
      return core.streamCancel;
    },
    get durableStream() {
      return core.durableStream;
    },
    get uploadService() {
      return core.uploadService;
    },
    get requestDispatch() {
      return core.requestDispatch;
    },
  };
}

/** Dep bag for connection accept, wake, and close logic. */
export function connectionRuntime(core: EngineCore) {
  return (depsMemoFor(core).connection ??= buildConnectionRuntime(core));
}

/**
 * Put a connection's persistent tags back into the live index. Reached
 * through the engine's `tagPersistenceService` slot, set by the `tags()`
 * capability — a handler that never lists `tags()` leaves the slot unset and
 * this is a no-op. Called on fresh connect and on hibernation wake.
 */
function reloadPersistentTags(core: EngineCore, connection: RuntimeConnection): void {
  core.tagPersistenceService?.restorePersistentTags({
    sql: core.storage.sql,
    tagMembers: core.tagMembers,
    connection,
    isGroupDeclared: (group: string) => core.isTagGroupDeclared('persistent', group),
    getSchema: (group: string) => core.getTagGroupSchema('persistent', group),
    logger: core.logger,
  });
}

function buildConnectionRuntime(core: EngineCore) {
  const buildCtx = buildConnectionContext(core);
  return {
    compiled: core.compiled,
    messageLimits: core.messageLimits,
    connections: core.connections,
    usersByKey: core.usersByKey,
    channelMembers: core.channelMembers,
    tagMembers: core.tagMembers,
    socketToConnectionId: core.socketToConnectionId,

    generateId: (prefix?: string) => core.generateId(prefix),

    replayEnabled: () => core.replayEnabled,
    hibernationAllowed: () => core.hibernationAllowed,
    allocateDeliverySeq: () => core.allocateDeliverySeq?.(),
    connectedSettings: (connection: RuntimeConnection) => {
      // The platform watches a connection that survives a sleep, so the engine pings it never.
      const timings = connection.survivesHibernation ? null : core.keepaliveTimings;
      const features: EngineConnectionRuntime.ConnectedFeature[] = [];
      if (core.replayEnabled) features.push('replay');
      if (core.binaryService) features.push('binary');
      if (core.uploadService) features.push('uploads');

      return {
        pingIntervalMs: timings?.pingIntervalMs ?? null,
        idleTimeoutMs: timings?.idleTimeoutMs ?? null,
        features,
      };
    },

    persistAttachment: (connection: RuntimeConnection, options?: PersistAttachmentOptions) =>
      EngineHibernation.persistAttachment(core, connection, options),

    flushAttachment: (connection: RuntimeConnection) =>
      EngineHibernation.flushDirtyAttachment(core, connection),

    restoreAttachment: (socketKey: unknown) => core.options.hibernation?.restore(socketKey),

    readConnectionState: (connectionId: string) =>
      EngineHibernation.readConnectionState(core, connectionId),

    deleteConnectionState: (connectionId: string) =>
      EngineHibernation.deleteConnectionState(core, connectionId),

    // Hibernation snapshots only carry ephemeral tags, so the wake path reloads
    // persistent tags by user id.
    reloadPersistentTags: (connection: RuntimeConnection) => reloadPersistentTags(core, connection),

    buildConnectionContext: buildCtx,

    runConnectionLifecycle: (kind: 'connect' | 'disconnect', ctx: Record<PropertyKey, unknown>) => {
      return runConnectionLifecycle(core, kind, ctx);
    },

    processTextMessage: (connection: RuntimeConnection, data: string) =>
      EngineMessageRuntime.processTextMessage(dispatchRuntime(core), connection, data),

    get processBinaryMessage() {
      const dispatch = core.binaryService?.dispatch;
      if (!dispatch) return undefined;

      return (connection: RuntimeConnection, data: Uint8Array) =>
        dispatch(dispatchRuntime(core), connection, data);
    },

    handleConnectionClose: (connection: RuntimeConnection, code: number, reason: string) =>
      handleConnectionClose(core, { connection, code, reason }),

    handleRuntimeError: (connection: RuntimeConnection, error: unknown, event?: string) =>
      EngineErrorRuntime.handleRuntimeError(
        { core, buildConnectionContext: buildCtx },
        connection,
        { error, event },
      ),
    handlePluginConnectError: (connection: RuntimeConnection, error: unknown, pluginId: string) =>
      EngineErrorRuntime.handleRuntimeError(
        { core, buildConnectionContext: buildCtx },
        connection,
        { error, pluginId },
      ),
    handleSocketError: (connection: RuntimeConnection, error: unknown) =>
      EngineErrorRuntime.handleRuntimeError(
        { core, buildConnectionContext: buildCtx },
        connection,
        { error, fromSocket: true },
      ),
    autoRejoinIdentity: (connection: RuntimeConnection) => {
      if (core.freshBoot) {
        core.freshBoot = false;
        return Promise.resolve();
      }

      // Restore persistent tags before channel auto-rejoin so its check/revalidate
      // hooks can read them via `ctx.tags.persistent(...)`. Independent of
      // `channelMembershipService` — a handler with `tags()` and no `channels()`
      // still gets its tags back.
      reloadPersistentTags(core, connection);
      const rejoined =
        core.channelMembershipService?.autoRejoinIdentity(
          core,
          (ref: PublicApi.ConnectionRef, opts: unknown) =>
            core.channelService?.subscribeFromServer(
              core,
              ref,
              opts as Parameters<
                NonNullable<EngineCore['channelService']>['subscribeFromServer']
              >[2],
            ) ?? Promise.resolve(),
          connection,
        ) ?? Promise.resolve();
      // Drain the reconnecting member's owed inbox rows after the rejoin
      // loop has restored its channel memberships.
      if (!core.inboxService) return rejoined;

      // The drain can wait for the socket's buffer, so it does not hold up the connection's
      // other work: messages, heartbeats and onConnect go on while it waits.
      return rejoined.then(() => {
        const drain = core.inboxService?.drainOnReconnect(core, connection);
        if (!drain) return;

        core.trackBackgroundWork(
          drain.catch((error: unknown) => {
            core.logger.error('[livething] inbox drain failed', {
              connectionId: connection.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }),
        );
      });
    },
  };
}

/** Callbacks needed by `createEngineAccess` and `initialize`. */
export function engineAccessDeps(core: EngineCore): EngineAccessDeps {
  const buildCtx = buildConnectionContext(core);
  return {
    buildConnectionlessContext: () => connectionlessContext(core),
    ensureScheduledRuntime: () =>
      core.scheduledService?.ensureRuntime(core, connectionlessContextFactory(core)),
    scheduleTask: (opts) =>
      core.scheduledService?.scheduleTask(core, connectionlessContextFactory(core), opts),
    cancelScheduled: (opts) =>
      core.scheduledService?.cancelScheduled(core, connectionlessContextFactory(core), opts),
    rescheduleAlarm: () => rescheduleEngineAlarm(core),
    buildCurrentContext: () => {
      const activeId = core.asyncContext.getStore()?.connectionId;
      const connection = activeId ? core.connections.get(activeId) : undefined;
      return connection ? buildCtx(connection) : undefined;
    },
    buildContextForConnection: (connectionId) => {
      const connection = core.connections.get(connectionId);
      return connection ? buildCtx(connection) : undefined;
    },
    sendServerRequest: (connectionId, opts) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return false;

      return OutgoingRuntime.sendThroughPipeline(outgoingRuntime(core), connection, {
        routing: {
          correlationId: opts.correlationId,
          // The server originated this request, so the client can fast-fail with
          // `request-no-response` when it has no handler.
          source: 'server',
          channel: opts.channel,
          channelFamily: opts.channelFamily,
        },
        event: opts.event,
        payload: opts.payload,
      });
    },
    openServerRequestBroadcast: (opts) => {
      const send = OutgoingRuntime.openSharedSend(outgoingRuntime(core), {
        routing: { source: 'server' },
        event: opts.event,
        payload: opts.payload,
        target: opts.target,
      });
      return {
        send(connectionId, correlationId) {
          const connection = core.connections.get(connectionId);
          if (!connection) return false;

          return send.deliver(connection, { correlationId });
        },
        finish: () => send.finish(),
      };
    },
    broadcastToChannel: (opts) => {
      OutgoingRuntime.broadcastToChannel(memberRuntime(core), {
        channelName: opts.channelName,
        channelFamily: opts.channelFamily,
        event: opts.event,
        payload: opts.payload,
        excludeConnectionId: undefined,
      });
    },
    channelMemberCount: (channelName, channelFamily) =>
      core.channelMembers.get(
        ChannelPrimitive.createChannelMembershipKey(channelName, channelFamily),
      )?.size ?? 0,
  };
}

/** Run connect/disconnect lifecycle hooks for the handler and every plugin. */
function runConnectionLifecycle(
  core: EngineCore,
  kind: 'connect' | 'disconnect',
  ctx: Record<PropertyKey, unknown>,
): Promise<void> {
  return EngineConnectionRuntime.runConnectionLifecycle(
    {
      asyncContext: core.asyncContext,
      connectHooks: core.hooks.connect,
      disconnectHooks: core.hooks.disconnect,
      pluginConnectHooks: core.hooks.pluginLifecycle.connect,
      pluginDisconnectHooks: core.hooks.pluginLifecycle.disconnect,
    },
    kind,
    ctx,
  );
}

/** Close one connection fully: cancel streams, fire disconnect, leave channels. */
export function handleConnectionClose(
  core: EngineCore,
  opts: EngineConnectionRuntime.HandleConnectionCloseOptions,
): Promise<void> {
  return EngineConnectionRuntime.handleConnectionClose(
    {
      compiled: core.compiled,
      connections: core.connections,
      usersByKey: core.usersByKey,
      tagMembers: core.tagMembers,
      socketToConnectionId: core.socketToConnectionId,
      deleteConnectionState: (connectionId) =>
        EngineHibernation.deleteConnectionState(core, connectionId),
      cancelActiveStreamsForConnection: (connectionId) =>
        EngineConnectionRuntime.cancelActiveStreamsForConnection(
          { activeStreams: core.activeStreams },
          connectionId,
        ),
      buildConnectionContext: buildConnectionContext(core),
      runConnectionLifecycle: (kind, ctx) => runConnectionLifecycle(core, kind, ctx),
      leaveChannel: (connection, leaveOptions) =>
        core.channelService?.leaveChannel(core, connection, leaveOptions) ?? Promise.resolve(),
      connectionCleanupHooks: core.hooks.connectionCleanup,
      logger: core.logger,
    },
    opts,
  );
}
