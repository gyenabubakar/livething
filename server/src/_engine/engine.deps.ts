/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as EngineContexts from '~/_engine/contexts/contexts.ts';
import * as EngineConnectionRuntime from '~/_engine/runtime/connection.ts';
import * as EngineErrorRuntime from '~/_engine/runtime/error.ts';
import * as EngineHibernation from '~/_engine/runtime/hibernation.ts';
import * as EngineMessageRuntime from '~/_engine/runtime/messages.ts';
import { sendProtocolMessage, sendReplay } from '~/_engine/runtime/wire.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as OutgoingRuntime from '~/outgoing/runtime.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { EngineAccessDeps } from '~/_engine/registry/engine-access.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type ResolvedChannel = EngineRuntimeTypes.ResolvedChannel;
type RoutingTarget = EngineRuntimeTypes.RoutingTarget;
type BroadcastOptions = PublicApi.BroadcastOptions;

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

/** Shared dep bag for init, shutdown, task, and connection context builders. */
export function commonDeps(core: EngineCore): EngineContextTypes.ContextCommonDeps {
  return (depsMemoFor(core).common ??= buildCommonDeps(core));
}

function buildCommonDeps(core: EngineCore): EngineContextTypes.ContextCommonDeps {
  return {
    env: core.env,
    logger: core.logger,
    platform: core.platform,
    waitUntilImpl: core.waitUntilImpl,
    getStorage: () => core.storage,
    getTimers: () => core.timers,
    scheduleTask: (taskId, time, data) =>
      core.scheduledService?.scheduleTask(core, commonDeps(core), { taskId, time, data }),
    cancelScheduled: (taskId, filter) =>
      core.scheduledService?.cancelScheduled(core, commonDeps(core), { taskId, filter }) ?? {
        removed: 0,
        taskExists: false,
      },
    broadcastToConnections: (connections, opts) => {
      OutgoingRuntime.broadcastToConnections(outgoingRuntime(core), connections, opts);
    },
    sendThroughPipeline: (connection, opts) => {
      return OutgoingRuntime.sendThroughPipeline(outgoingRuntime(core), connection, opts);
    },
    broadcastToChannel: (opts) => {
      OutgoingRuntime.broadcastToChannel(memberRuntime(core), opts);
    },
    sendToChannelRecipient: (opts) => {
      const targets = ChannelPrimitive.resolveChannelRecipients(core.channelMembers, {
        channelName: opts.channelName,
        channelFamily: opts.channelFamily,
        to: opts.to,
      });
      let delivered = 0;
      for (const target of targets) {
        const sent = OutgoingRuntime.sendThroughPipeline(outgoingRuntime(core), target, {
          routing: { channel: opts.channelName, channelFamily: opts.channelFamily },
          event: opts.event,
          payload: opts.payload,
        });
        if (sent) delivered += 1;
      }
      return delivered;
    },
    getChannelMembers: (channelName, channelFamily) =>
      core.channelService?.getChannelMembers(core, channelName, channelFamily) ?? [],
    kickChannelMembers: (opts) =>
      core.channelService?.kickChannelMembers(core, opts) ?? Promise.resolve(),
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
        hibernationEnabled: core.hibernationEnabled,
        lastSeenAt: core.lastSeenService
          ? (identity) => core.lastSeenService!.at(identity)
          : undefined,
      }),
    contextExtenders: core.hooks.contextExtenders,
    instanceId: core.engineInstanceId,
    usesTags: core.usesTags(),
    persistenceEnabled: core.persistenceEnabled,
    isTagGroupDeclared: (kind, group) => core.isTagGroupDeclared(kind, group),
    getTagGroupSchema: (kind, group) => core.getTagGroupSchema(kind, group),
    channelHandleAugmenters: core.channelHandleAugmenters,
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
    wskitStampHooks: core.hooks.wskitStamp,
    beforeSendHooks: core.hooks.beforeSend,
    afterSendHooks: core.hooks.afterSend,
    waitUntil: (promise: Promise<unknown>) => core.waitUntilImpl(promise),
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
        hibernationEnabled: core.hibernationEnabled,
        lastSeenAt: core.lastSeenService
          ? (identity) => core.lastSeenService!.at(identity)
          : undefined,
      }),
    sendThroughPipeline: (
      connection: RuntimeConnection,
      opts: { routing: RoutingTarget | undefined; event: string; payload: unknown },
    ) => OutgoingRuntime.sendThroughPipeline(outgoingRuntime(core), connection, opts),
    inboxFanOut: core.inboxService
      ? (opts: {
          channelName: string;
          channelFamily: string | null;
          event: string;
          payload: Record<string, unknown>;
          seq: number;
          messageId: string;
        }) => core.inboxService?.fanOut(core, opts)
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

    broadcastToChannel: (opts: ChannelPrimitive.BroadcastToChannelOptions) => {
      OutgoingRuntime.broadcastToChannel(dispatchRuntime(core), opts);
    },

    buildConnectionContext: buildCtx,

    persistAttachment: (connection: RuntimeConnection) =>
      EngineHibernation.persistAttachment(core, connection),

    sendProtocolMessage: (
      connection: RuntimeConnection,
      opts: { event: string; payload: Record<string, unknown>; wskit: Record<string, unknown> },
    ) => sendProtocolMessage(core, connection, opts),

    handleValidationError: (
      connection: RuntimeConnection,
      opts: { event: string; validationError: unknown; scope?: ResolvedChannel },
    ) =>
      EngineErrorRuntime.handleValidationError(
        { core, buildConnectionContext: buildCtx },
        connection,
        opts,
      ),

    handleRuntimeError: (
      connection: RuntimeConnection,
      opts: { error: unknown; event?: string; routing?: Protocol.WSKitRouting },
    ) =>
      EngineErrorRuntime.handleRuntimeError(
        { core, buildConnectionContext: buildCtx },
        connection,
        opts,
      ),

    isChannelPersistent: (channelKey: string) => core.isChannelPersistent(channelKey),

    persistMembership: (userId: string, channelName: string, channelFamily: string | null) =>
      core.channelMembershipService?.persistMembership(core, {
        userId,
        channelName,
        channelFamily,
      }),

    deleteDurableMembership: (userId: string, channelName: string, channelFamily: string | null) =>
      core.channelMembershipService?.deleteDurableMembership(core, {
        userId,
        channelName,
        channelFamily,
      }),

    hasDurableMembership: (userId: string, channelName: string, channelFamily: string | null) =>
      core.channelMembershipService?.hasDurableMembership(core, {
        userId,
        channelName,
        channelFamily,
      }) ?? false,

    clearInbox: (userId: string, channelName: string, channelFamily: string | null) =>
      core.inboxService?.clearChannel(core, { userId, channelName, channelFamily }),

    isInboxChannel: (channelName: string, channelFamily: string | null) =>
      core.inboxChannels.has(channelFamily ?? channelName),

    isReadReceiptsChannel: (channelName: string, channelFamily: string | null) =>
      core.readReceiptsChannels.has(channelFamily ?? channelName),

    logger: core.logger,
  };
}

/** Dep bag for inbound text-message dispatch. */
export function dispatchRuntime(core: EngineCore) {
  return (depsMemoFor(core).dispatch ??= buildDispatchRuntime(core));
}

function buildDispatchRuntime(core: EngineCore) {
  const buildCtx = buildConnectionContext(core);
  return {
    ...memberRuntime(core),

    logger: core.logger,
    activeStreams: core.activeStreams,
    sql: core.storage.sql,
    protocolHandlers: core.hooks.protocol,
    incomingHooks: core.hooks.incoming,
    answerFrameHooks: core.hooks.answerFrame,
    errorHooks: core.hooks.error,
    declaredErrorCodes: core.declaredErrorCodes,
    incomingDedupCap: core.incomingDedupCap,

    getTimers: () => core.timers,

    buildConnectionContext: buildCtx,

    sendProtocolMessage: (
      connection: RuntimeConnection,
      opts: { event: string; payload: Record<string, unknown>; wskit: Record<string, unknown> },
    ) => sendProtocolMessage(core, connection, opts),

    sendReplay: (
      connection: RuntimeConnection,
      opts: {
        channelName: string | null;
        channelFamily: string | null;
        event: string;
        payload: unknown;
        wire: { seq: number; messageId: string; channel?: string };
      },
    ) => sendReplay(core, connection, opts),

    persistAttachment: (connection: RuntimeConnection) =>
      EngineHibernation.persistAttachment(core, connection),

    handleRuntimeError: (
      connection: RuntimeConnection,
      opts: { error: unknown; event?: string; routing?: Protocol.WSKitRouting },
    ) =>
      EngineErrorRuntime.handleRuntimeError(
        { core, buildConnectionContext: buildCtx },
        connection,
        opts,
      ),

    handleValidationError: (
      connection: RuntimeConnection,
      opts: { event: string; validationError: unknown; scope?: ResolvedChannel },
    ) =>
      EngineErrorRuntime.handleValidationError(
        { core, buildConnectionContext: buildCtx },
        connection,
        opts,
      ),

    broadcastToConnections: (
      connections: readonly RuntimeConnection[],
      opts: {
        event: string;
        payload: unknown;
        options?: BroadcastOptions;
        excludeConnectionId?: string;
      },
    ) => OutgoingRuntime.broadcastToConnections(outgoingRuntime(core), connections, opts),

    handleSubscribe: (connection: RuntimeConnection, frame: Protocol.SubscribeFrame) =>
      core.channelService?.handleSubscribe(core, connection, frame) ?? Promise.resolve(),
    handleUnsubscribe: (connection: RuntimeConnection, frame: Protocol.UnsubscribeFrame) =>
      core.channelService?.handleUnsubscribe(core, connection, frame) ?? Promise.resolve(),
    handleMemberSync: (connection: RuntimeConnection, frame: Protocol.MemberSyncRequestFrame) => {
      core.channelService?.handleMemberSync(core, connection, frame);
    },
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
    get requestDispatch() {
      return core.requestDispatch;
    },
    get runIntercepts() {
      return core.runIntercepts;
    },
  };
}

/** Dep bag for connection accept, wake, and close logic. */
export function connectionRuntime(core: EngineCore) {
  return (depsMemoFor(core).connection ??= buildConnectionRuntime(core));
}

function buildConnectionRuntime(core: EngineCore) {
  const buildCtx = buildConnectionContext(core);
  return {
    compiled: core.compiled,
    hibernationEnabled: core.hibernationEnabled,
    connections: core.connections,
    usersByKey: core.usersByKey,
    channelMembers: core.channelMembers,
    tagMembers: core.tagMembers,
    wsToConnectionId: core.wsToConnectionId,

    generateId: (prefix?: string) => core.generateId(prefix),

    persistAttachment: (connection: RuntimeConnection) =>
      EngineHibernation.persistAttachment(core, connection),

    restoreAttachment: (wsKey: unknown) => core.options.hibernation?.restore(wsKey),

    readConnectionState: (connectionId: string) =>
      EngineHibernation.readConnectionState(core, connectionId),

    deleteConnectionState: (connectionId: string) =>
      EngineHibernation.deleteConnectionState(core, connectionId),

    // Hibernation snapshots only carry ephemeral tags, so the wake path reloads
    // persistent tags by user id. Wired only when persistence is on.
    ...(core.persistenceEnabled
      ? {
          reloadPersistentTags: (connection: RuntimeConnection) =>
            core.tagPersistenceService?.restorePersistentTags({
              sql: core.storage.sql,
              tagMembers: core.tagMembers,
              connection,
              getSchema: (group: string) => core.getTagGroupSchema('persistent', group),
              logger: core.logger,
            }),
        }
      : {}),

    buildConnectionContext: buildCtx,

    runConnectionLifecycle: (kind: 'connect' | 'disconnect', ctx: Record<PropertyKey, unknown>) => {
      return runConnectionLifecycle(core, kind, ctx);
    },

    processTextMessage: (connection: RuntimeConnection, data: string) =>
      EngineMessageRuntime.processTextMessage(dispatchRuntime(core), connection, data),

    handleConnectionClose: (connection: RuntimeConnection, code: number, reason: string) =>
      handleConnectionClose(core, { connection, code, reason }),

    handleRuntimeError: (connection: RuntimeConnection, error: unknown, event?: string) =>
      EngineErrorRuntime.handleRuntimeError(
        { core, buildConnectionContext: buildCtx },
        connection,
        { error, event },
      ),
    // Only wire auto-rejoin when persistence is on. Otherwise the connect path
    // adds a microtask and shifts `runConnectionLifecycle('connect')` timing.
    ...(core.persistenceEnabled
      ? {
          autoRejoinIdentity: (connection: RuntimeConnection) => {
            if (core.freshBoot) {
              core.freshBoot = false;
              return Promise.resolve();
            }
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
            return rejoined.then(() => core.inboxService?.drainOnReconnect(core, connection));
          },
        }
      : {}),
  };
}

/** Callbacks needed by `createEngineAccess` and `initialize`. */
export function engineAccessDeps(core: EngineCore): EngineAccessDeps {
  const buildCtx = buildConnectionContext(core);
  return {
    ensureScheduledRuntime: () => core.scheduledService?.ensureRuntime(core, commonDeps(core)),
    createTaskContext: () => core.scheduledService?.createTaskContext(core, commonDeps(core)),
    scheduleTask: (opts) => core.scheduledService?.scheduleTask(core, commonDeps(core), opts),
    cancelScheduled: (opts) =>
      core.scheduledService?.cancelScheduled(core, commonDeps(core), opts) ?? {
        removed: 0,
        taskExists: false,
      },
    rescheduleAlarm: () => core.scheduledService?.rescheduleAlarm(core),
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
export function runConnectionLifecycle(
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
      wsToConnectionId: core.wsToConnectionId,
      cancelActiveStreamsForConnection: (connectionId) =>
        EngineConnectionRuntime.cancelActiveStreamsForConnection(
          { activeStreams: core.activeStreams },
          connectionId,
        ),
      buildConnectionContext: buildConnectionContext(core),
      runConnectionLifecycle: (kind, ctx) => runConnectionLifecycle(core, kind, ctx),
      leaveChannel: (connection, opts) =>
        core.channelService?.leaveChannel(core, connection, opts) ?? Promise.resolve(),
      connectionCleanupHooks: core.hooks.connectionCleanup,
      logger: core.logger,
    },
    opts,
  );
}
