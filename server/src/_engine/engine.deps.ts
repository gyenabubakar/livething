/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as EngineContexts from '~/_engine/contexts/contexts.ts';
import * as EngineChannelFrames from '~/_engine/runtime/channel-frames.ts';
import * as EngineConnectionRuntime from '~/_engine/runtime/connection.ts';
import * as EngineErrorRuntime from '~/_engine/runtime/error.ts';
import * as EngineHibernation from '~/_engine/runtime/hibernation.ts';
import * as EngineMessageRuntime from '~/_engine/runtime/messages.ts';
import { sendProtocolMessage, sendReplay } from '~/_engine/runtime/wire.ts';
import * as Scheduling from '~/_engine/scheduling.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as MembershipPersistence from '~/persistence/membership.ts';
import * as RejoinPersistence from '~/persistence/rejoin.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { EngineAccessDeps } from '~/_engine/registry/engine-access.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type ResolvedScope = EngineRuntimeTypes.ResolvedScope;
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

/** Bound `leaveChannel` closure used by persistence and identity ops. */
function buildLeaveChannel(core: EngineCore) {
  return (connection: RuntimeConnection, opts: ChannelPrimitive.LeaveChannelOptions) =>
    EngineChannelFrames.leaveChannel(channelRuntime(core), connection, opts);
}

/** The constant dep bag passed to `EngineContexts.buildConnectionContext`. */
function ctxDeps(core: EngineCore): EngineContextTypes.BuildConnectionContextDeps {
  return (depsMemoFor(core).ctxDeps ??= {
    compiled: core.compiled,
    connections: core.connections,
    tagMembers: core.tagMembers,
    hibernationEnabled: core.hibernationEnabled,
    ...commonDeps(core),
  });
}

/** Closure that builds a live-connection context. Used by error + dispatch helpers. */
function buildConnectionContext(core: EngineCore) {
  return (connection: RuntimeConnection, scope?: ResolvedScope) =>
    EngineContexts.buildConnectionContext(ctxDeps(core), connection, scope);
}

/** Factory for the task context passed to scheduled handlers. */
function buildTaskContextFactory(core: EngineCore): () => unknown {
  return () =>
    EngineContexts.createTaskContext({
      connections: core.connections,
      ...commonDeps(core),
    });
}

/** Shared dep bag for init, shutdown, task, and connection context builders. */
export function commonDeps(core: EngineCore): EngineContextTypes.ContextCommonDeps {
  return (depsMemoFor(core).common ??= buildCommonDeps(core));
}

function buildCommonDeps(core: EngineCore): EngineContextTypes.ContextCommonDeps {
  const createTaskContext = buildTaskContextFactory(core);
  return {
    env: core.env,
    logger: core.logger,
    platform: core.platform,
    waitUntilImpl: core.waitUntilImpl,
    requireStorage: () => core.requireStorage(),
    getTimers: () => core.timers,
    scheduleTask: (taskId, time, data) =>
      Scheduling.scheduleTask(core, createTaskContext, { taskId, time, data }),
    cancelScheduled: (taskId, filter) =>
      Scheduling.cancelScheduled(core, createTaskContext, { taskId, filter }),
    broadcastToConnections: (connections, opts) => {
      EngineMessageRuntime.broadcastToConnections(outgoingRuntime(core), connections, opts);
    },
    sendThroughPipeline: (connection, opts) => {
      return EngineMessageRuntime.sendThroughPipeline(outgoingRuntime(core), connection, opts);
    },
    broadcastToChannel: (opts) => {
      EngineMessageRuntime.broadcastToChannel(memberRuntime(core), opts);
    },
    getChannelMembers: (channelName, channelScope) =>
      EngineChannelFrames.getChannelMembers(memberRuntime(core), channelName, channelScope),
    kickChannelMembers: (opts) => {
      return EngineChannelFrames.kickChannelMembers(
        { ...channelRuntime(core), leaveChannel: buildLeaveChannel(core) },
        opts,
      );
    },
    removeChannelMember: (channelName, channelScope, identity) => {
      return MembershipPersistence.removeChannelMember(core, buildLeaveChannel(core), {
        identity,
        channelName,
        channelScope,
      });
    },
    subscribeConnectionAsServer: (ref, opts) => {
      return EngineChannelFrames.subscribeFromServer(
        { ...channelRuntime(core), instanceId: core.engineInstanceId },
        ref,
        opts,
      );
    },
    resolveChannel: (target) => {
      if (typeof target === 'string') {
        const compiledChannel = core.compiled.channels.get(target);
        if (!compiledChannel) return undefined;
        return { channelName: target, channelScope: null, params: {} };
      }
      const family = core.compiled.channelFamilies.get(target.family);
      if (!family) return undefined;
      if (!ChannelPrimitive.matchesScopePattern(family.pattern, target.name)) return undefined;
      return {
        channelName: target.name,
        channelScope: target.family,
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
      EngineContexts.toConnectionInfo(connection, core.engineInstanceId, core.hibernationEnabled),
    getPluginApiFactory: (id: string) => core.pluginApiFactories.get(id),
    contextExtenders: core.hooks.contextExtenders,
    instanceId: core.engineInstanceId,
    usesTags: core.usesTags(),
    persistenceEnabled: core.persistenceEnabled,
    isTagGroupDeclared: (kind, group) => core.isTagGroupDeclared(kind, group),
    getTagGroupSchema: (kind, group) => core.getTagGroupSchema(kind, group),
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
      EngineContexts.toConnectionInfo(connection, core.engineInstanceId, core.hibernationEnabled),
    sendThroughPipeline: (
      connection: RuntimeConnection,
      opts: { routing: RoutingTarget | undefined; event: string; payload: unknown },
    ) => EngineMessageRuntime.sendThroughPipeline(outgoingRuntime(core), connection, opts),
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
      EngineMessageRuntime.broadcastToChannel(dispatchRuntime(core), opts);
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
      opts: { event: string; validationError: unknown; scope?: ResolvedScope },
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

    persistMembership: (identity: string, channelName: string, channelScope: string | null) =>
      MembershipPersistence.persistMembership(core, { identity, channelName, channelScope }),

    deleteDurableMembership: (identity: string, channelName: string, channelScope: string | null) =>
      MembershipPersistence.deleteDurableMembership(core, { identity, channelName, channelScope }),

    hasDurableMembership: (identity: string, channelName: string, channelScope: string | null) =>
      MembershipPersistence.hasDurableMembership(core, { identity, channelName, channelScope }),

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
    sql: core.storageOrUndefined()?.sql,
    protocolHandlers: core.hooks.protocol,
    incomingHooks: core.hooks.incoming,
    answerFrameHooks: core.hooks.answerFrame,
    ackFrameHooks: core.hooks.ackFrame,
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
        channelScope: string | null;
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
      opts: { event: string; validationError: unknown; scope?: ResolvedScope },
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
    ) => EngineMessageRuntime.broadcastToConnections(outgoingRuntime(core), connections, opts),

    handleSubscribe: (connection: RuntimeConnection, frame: Protocol.SubscribeFrame) =>
      EngineChannelFrames.handleSubscribe(channelRuntime(core), connection, frame),
    handleUnsubscribe: (connection: RuntimeConnection, frame: Protocol.UnsubscribeFrame) =>
      EngineChannelFrames.handleUnsubscribe(
        {
          ...channelRuntime(core),
          leaveChannel: buildLeaveChannel(core),
        },
        connection,
        frame,
      ),
    durableStreamSchemaReady: false,
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
    keepalivePingIntervalMs: core.keepalivePingIntervalMs,
    connections: core.connections,
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
    // persistent tags by identity. Wired only when persistence is on.
    ...(core.persistenceEnabled
      ? {
          reloadPersistentTags: (connection: RuntimeConnection) =>
            RejoinPersistence.restorePersistentTags({
              sql: core.requireStorage().sql,
              tagMembers: core.tagMembers,
              connection,
              getSchema: (group) => core.getTagGroupSchema('persistent', group),
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
            return MembershipPersistence.autoRejoinIdentity(
              core,
              (ref, opts) =>
                EngineChannelFrames.subscribeFromServer(
                  { ...channelRuntime(core), instanceId: core.engineInstanceId },
                  ref,
                  opts,
                ),
              connection,
            );
          },
        }
      : {}),
  };
}

/** Callbacks needed by `createEngineAccess` and `initialize`. */
export function engineAccessDeps(core: EngineCore): EngineAccessDeps {
  const createTaskContext = buildTaskContextFactory(core);
  const buildCtx = buildConnectionContext(core);
  return {
    ensureScheduledRuntime: () => Scheduling.ensureScheduledRuntime(core, createTaskContext),
    createTaskContext,
    rescheduleAlarm: () => Scheduling.rescheduleAlarm(core),
    buildCurrentContext: () => {
      const activeId = core.asyncContext.getStore()?.connectionId;
      const connection = activeId ? core.connections.get(activeId) : undefined;
      return connection ? buildCtx(connection) : undefined;
    },
    sendServerRequest: (connectionId, opts) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return false;
      return EngineMessageRuntime.sendThroughPipeline(outgoingRuntime(core), connection, {
        routing: {
          correlationId: opts.correlationId,
          // The server originated this request, so the client can fast-fail with
          // `request-no-response` when it has no handler.
          source: 'server',
          channel: opts.channel,
          channelScope: opts.channelScope,
        },
        event: opts.event,
        payload: opts.payload,
      });
    },
    sendServerWithAck: (connectionId, opts) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return false;
      return EngineMessageRuntime.sendThroughPipeline(outgoingRuntime(core), connection, {
        routing: {
          ackId: opts.ackId,
          // The server originated this acked send.
          source: 'server',
          channel: opts.channel,
          channelScope: opts.channelScope,
        },
        event: opts.event,
        payload: opts.payload,
      });
    },
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
      tagMembers: core.tagMembers,
      wsToConnectionId: core.wsToConnectionId,
      cancelActiveStreamsForConnection: (connectionId) =>
        EngineConnectionRuntime.cancelActiveStreamsForConnection(
          { activeStreams: core.activeStreams },
          connectionId,
        ),
      buildConnectionContext: buildConnectionContext(core),
      runConnectionLifecycle: (kind, ctx) => runConnectionLifecycle(core, kind, ctx),
      leaveChannel: buildLeaveChannel(core),
      logger: core.logger,
    },
    opts,
  );
}
