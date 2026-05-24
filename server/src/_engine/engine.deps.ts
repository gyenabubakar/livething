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
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type ResolvedScope = EngineRuntimeTypes.ResolvedScope;
type RoutingTarget = EngineRuntimeTypes.RoutingTarget;
type BroadcastOptions = PublicApi.BroadcastOptions;
type CompiledChannel = EngineRuntimeTypes.ResolvedScope['channel'];

// ─────── dep-bag memoization ───────

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

// ─────── shared helpers ───────

/** Bound `leaveChannel` closure used by persistence and identity ops. */
function buildLeaveChannel(core: EngineCore) {
  return (
    connection: RuntimeConnection,
    scope: { channel?: CompiledChannel; channelName: string; channelScope: string | null },
    kickedReason?: string,
    disconnect?: boolean,
  ) =>
    EngineChannelFrames.leaveChannel(
      channelRuntime(core),
      connection,
      scope,
      kickedReason,
      disconnect,
    );
}

/** The constant dep bag passed to `EngineContexts.buildConnectionContext`. */
function ctxDeps(core: EngineCore): EngineContextTypes.BuildConnectionContextDeps {
  return (depsMemoFor(core).ctxDeps ??= {
    compiled: core.compiled,
    connections: core.connections,
    tagMembers: core.tagMembers,
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

// ─────── common deps ───────

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
    requireTimers: () => core.requireTimers(),
    scheduleTask: (taskId, time, data) =>
      Scheduling.scheduleTask(core, createTaskContext, taskId, time, data),
    cancelScheduled: (taskId, filter) =>
      Scheduling.cancelScheduled(core, createTaskContext, taskId, filter),
    broadcastToConnections: (connections, event, payload, options, excludeConnectionId) => {
      EngineMessageRuntime.broadcastToConnections(
        outgoingRuntime(core),
        connections,
        event,
        payload,
        options,
        excludeConnectionId,
      );
    },
    sendThroughPipeline: (connection, routing, event, payload) => {
      return EngineMessageRuntime.sendThroughPipeline(
        outgoingRuntime(core),
        connection,
        routing,
        event,
        payload,
      );
    },
    broadcastToChannel: (
      channelName,
      event,
      payload,
      excludeConnectionId,
      channelScope,
      excludeSelf,
    ) => {
      EngineMessageRuntime.broadcastToChannel(
        memberRuntime(core),
        channelName,
        event,
        payload,
        excludeConnectionId,
        channelScope,
        excludeSelf,
      );
    },
    getChannelMembers: (channelName, channelScope) =>
      EngineChannelFrames.getChannelMembers(memberRuntime(core), channelName, channelScope),
    kickChannelMembers: (channelName, target, reason, channelScope) => {
      return EngineChannelFrames.kickChannelMembers(
        {
          ...channelRuntime(core),
          leaveChannel: buildLeaveChannel(core),
        },
        channelName,
        target,
        reason,
        channelScope,
      );
    },
    removeChannelMember: (channelName, channelScope, identity) => {
      return MembershipPersistence.removeChannelMember(
        core,
        buildLeaveChannel(core),
        channelName,
        channelScope,
        identity,
      );
    },
    subscribeConnectionAsServer: (ref, channelName, channelScope, payload) => {
      return EngineChannelFrames.subscribeFromServer(
        { ...channelRuntime(core), instanceId: core.engineInstanceId },
        ref,
        channelName,
        channelScope,
        payload,
      );
    },
    resolveChannel: (target) => {
      if (typeof target === 'string') {
        const compiledChannel = core.compiled.channels.get(target);
        if (!compiledChannel) return undefined;
        return { channelName: target, channelScope: null };
      }
      const family = core.compiled.channelFamilies.get(target.family);
      if (!family) return undefined;
      if (!ChannelPrimitive.matchesScopePattern(family.pattern, target.name)) return undefined;
      return { channelName: target.name, channelScope: target.family };
    },
    sendReplay: (connection, channelName, channelScope, event, payload, wire) => {
      sendReplay(core, connection, channelName, channelScope, event, payload, wire);
    },
    sendProtocolMessage: (connection, event, payload, wskit) => {
      sendProtocolMessage(core, connection, event, payload, wskit);
    },
    persistAttachment: (connection) => EngineHibernation.persistAttachment(core, connection),
    toConnectionInfo: (connection) =>
      EngineContexts.toConnectionInfo(connection, core.engineInstanceId),
    attachModuleApis: (ctx, connection) =>
      EngineContexts.attachModuleApis(core.moduleRuntimes, ctx, connection),
    contextExtenders: core.hooks.contextExtenders,
    instanceId: core.engineInstanceId,
    usesTags: core.usesTags(),
    persistenceEnabled: core.persistenceEnabled,
    isTagGroupDeclared: (kind, group) => core.isTagGroupDeclared(kind, group),
  };
}

// ─────── outgoing runtime bag ───────

/** Dep bag for helpers that only touch outgoing messages. */
export function outgoingRuntime(core: EngineCore) {
  return (depsMemoFor(core).outgoing ??= buildOutgoingRuntime(core));
}

function buildOutgoingRuntime(core: EngineCore) {
  return {
    compiled: core.compiled,
    moduleRuntimes: core.moduleRuntimes,
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

// ─────── member runtime bag ───────

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
      EngineContexts.toConnectionInfo(connection, core.engineInstanceId),
    sendThroughPipeline: (
      connection: RuntimeConnection,
      routing: RoutingTarget | undefined,
      event: string,
      payload: unknown,
    ) =>
      EngineMessageRuntime.sendThroughPipeline(
        outgoingRuntime(core),
        connection,
        routing,
        event,
        payload,
      ),
  };
}

// ─────── channel runtime bag ───────

/** Dep bag for channel subscribe/unsubscribe helpers. */
export function channelRuntime(core: EngineCore) {
  return (depsMemoFor(core).channel ??= buildChannelRuntime(core));
}

function buildChannelRuntime(core: EngineCore) {
  const buildCtx = buildConnectionContext(core);
  return {
    ...memberRuntime(core),
    checkHooks: core.hooks.check,
    commitHooks: core.hooks.commit,
    subscribeHooks: core.hooks.subscribe,
    unsubscribeHooks: core.hooks.unsubscribe,
    sessionEndHooks: core.hooks.sessionEnd,
    broadcastToChannel: (
      channelName: string,
      event: string,
      payload: unknown,
      excludeConnectionId: string | undefined,
      channelScope: string | null,
      excludeSelf?: boolean,
    ) => {
      EngineMessageRuntime.broadcastToChannel(
        dispatchRuntime(core),
        channelName,
        event,
        payload,
        excludeConnectionId,
        channelScope,
        excludeSelf,
      );
    },
    buildConnectionContext: buildCtx,
    persistAttachment: (connection: RuntimeConnection) =>
      EngineHibernation.persistAttachment(core, connection),
    sendProtocolMessage: (
      connection: RuntimeConnection,
      event: string,
      payload: Record<string, unknown>,
      wskit: Record<string, unknown>,
    ) => sendProtocolMessage(core, connection, event, payload, wskit),
    handleValidationError: (
      connection: RuntimeConnection,
      event: string,
      validationError: unknown,
      scope?: ResolvedScope,
    ) =>
      EngineErrorRuntime.handleValidationError(
        core,
        buildCtx,
        connection,
        event,
        validationError,
        scope,
      ),
    handleRuntimeError: (
      connection: RuntimeConnection,
      error: unknown,
      event?: string,
      routing?: Protocol.WskitRouting,
    ) => EngineErrorRuntime.handleRuntimeError(core, buildCtx, connection, error, event, routing),
    isChannelPersistent: (channelKey: string) => core.isChannelPersistent(channelKey),
    persistMembership: (identity: string, channelName: string, channelScope: string | null) =>
      MembershipPersistence.persistMembership(core, identity, channelName, channelScope),
    deleteDurableMembership: (identity: string, channelName: string, channelScope: string | null) =>
      MembershipPersistence.deleteDurableMembership(core, identity, channelName, channelScope),
    hasDurableMembership: (identity: string, channelName: string, channelScope: string | null) =>
      MembershipPersistence.hasDurableMembership(core, identity, channelName, channelScope),
    logger: core.logger,
  };
}

// ─────── dispatch runtime bag ───────

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
    errorHooks: core.hooks.error,
    incomingDedupCap: core.incomingDedupCap,
    requireTimers: () => core.requireTimers(),
    buildConnectionContext: buildCtx,
    sendProtocolMessage: (
      connection: RuntimeConnection,
      event: string,
      payload: Record<string, unknown>,
      wskit: Record<string, unknown>,
    ) => sendProtocolMessage(core, connection, event, payload, wskit),
    sendReplay: (
      connection: RuntimeConnection,
      channelName: string | null,
      channelScope: string | null,
      event: string,
      payload: unknown,
      wire: { seq: number; messageId: string; channel?: string },
    ) => sendReplay(core, connection, channelName, channelScope, event, payload, wire),
    persistAttachment: (connection: RuntimeConnection) =>
      EngineHibernation.persistAttachment(core, connection),
    handleRuntimeError: (
      connection: RuntimeConnection,
      error: unknown,
      event?: string,
      routing?: Protocol.WskitRouting,
    ) => EngineErrorRuntime.handleRuntimeError(core, buildCtx, connection, error, event, routing),
    handleValidationError: (
      connection: RuntimeConnection,
      event: string,
      validationError: unknown,
      scope?: ResolvedScope,
    ) =>
      EngineErrorRuntime.handleValidationError(
        core,
        buildCtx,
        connection,
        event,
        validationError,
        scope,
      ),
    broadcastToConnections: (
      connections: readonly RuntimeConnection[],
      event: string,
      payload: unknown,
      options?: BroadcastOptions & { namespace?: string },
      excludeConnectionId?: string,
    ) =>
      EngineMessageRuntime.broadcastToConnections(
        outgoingRuntime(core),
        connections,
        event,
        payload,
        options,
        excludeConnectionId,
      ),
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

// ─────── connection runtime bag ───────

/** Dep bag for connection accept, wake, and close logic. */
export function connectionRuntime(core: EngineCore) {
  return (depsMemoFor(core).connection ??= buildConnectionRuntime(core));
}

function buildConnectionRuntime(core: EngineCore) {
  const buildCtx = buildConnectionContext(core);
  return {
    compiled: core.compiled,
    timers: core.timers,
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
    buildConnectionContext: buildCtx,
    runConnectionLifecycle: (kind: 'connect' | 'disconnect', ctx: Record<PropertyKey, unknown>) => {
      return runConnectionLifecycle(core, kind, ctx);
    },
    processTextMessage: (connection: RuntimeConnection, data: string) =>
      EngineMessageRuntime.processTextMessage(dispatchRuntime(core), connection, data),
    handleBinaryMessage: (connection: RuntimeConnection, data: ArrayBuffer) =>
      handleBinaryMessage(core, connection, data),
    handleConnectionClose: (connection: RuntimeConnection, code: number, reason: string) =>
      handleConnectionClose(core, connection, code, reason),
    handleRuntimeError: (connection: RuntimeConnection, error: unknown, event?: string) =>
      EngineErrorRuntime.handleRuntimeError(core, buildCtx, connection, error, event),
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
              (ref, channelName, channelScope, payload, rejoining) =>
                EngineChannelFrames.subscribeFromServer(
                  { ...channelRuntime(core), instanceId: core.engineInstanceId },
                  ref,
                  channelName,
                  channelScope,
                  payload,
                  rejoining,
                ),
              connection,
            );
          },
        }
      : {}),
  };
}

// ─────── helpers exposed to the facade ───────

/** Callbacks needed by `createEngineAccess` and `initialize`. */
export function engineAccessDeps(core: EngineCore) {
  const createTaskContext = buildTaskContextFactory(core);
  return {
    ensureScheduledRuntime: () => Scheduling.ensureScheduledRuntime(core, createTaskContext),
    createTaskContext,
    rescheduleAlarm: () => Scheduling.rescheduleAlarm(core),
  };
}

/** Run connect/disconnect lifecycle hooks for the handler and every module. */
export function runConnectionLifecycle(
  core: EngineCore,
  kind: 'connect' | 'disconnect',
  ctx: Record<PropertyKey, unknown>,
): Promise<void> {
  return EngineConnectionRuntime.runConnectionLifecycle(
    {
      moduleRuntimes: core.moduleRuntimes,
      asyncContext: core.asyncContext,
      connectHooks: core.hooks.connect,
      disconnectHooks: core.hooks.disconnect,
      createModuleScopedContext: (moduleId, targetCtx) =>
        EngineContexts.createModuleScopedContext(moduleId, targetCtx),
    },
    kind,
    ctx,
  );
}

/** Close one connection fully: cancel streams, fire disconnect, leave channels. */
export function handleConnectionClose(
  core: EngineCore,
  connection: RuntimeConnection,
  code: number,
  reason: string,
): Promise<void> {
  return EngineConnectionRuntime.handleConnectionClose(
    {
      compiled: core.compiled,
      connections: core.connections,
      tagMembers: core.tagMembers,
      wsToConnectionId: core.wsToConnectionId,
      timers: core.timers,
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
    connection,
    code,
    reason,
  );
}

/** Route one binary frame into the optional binary lifecycle hook. */
export function handleBinaryMessage(
  core: EngineCore,
  connection: RuntimeConnection,
  data: ArrayBuffer,
): Promise<void> {
  const buildCtx = buildConnectionContext(core);
  return EngineConnectionRuntime.handleBinaryMessage(
    {
      buildConnectionContext: buildCtx,
      handleRuntimeError: (targetConnection, error, event) =>
        EngineErrorRuntime.handleRuntimeError(core, buildCtx, targetConnection, error, event),
      activityHooks: core.hooks.activity,
      binaryHooks: core.hooks.binary,
    },
    connection,
    data,
  );
}
