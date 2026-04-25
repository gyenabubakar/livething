/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as EngineMessageRuntime from '~/_engine/runtime/messages.ts';
import type * as EngineContextTypes from '~/_engine/contexts/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';
import type * as PublicApi from '~/context.ts';

type RuntimeConnection = EngineRuntimeTypes.RuntimeConnection;
type ResolvedScope = EngineRuntimeTypes.ResolvedScope;
type RoutingTarget = EngineRuntimeTypes.RoutingTarget;
type BroadcastOptions = PublicApi.BroadcastOptions;

// ─────── Section: common deps ───────

/**
 * Build the dependency bag shared by init, shutdown, task, and connection
 * context construction.
 */
export function commonDeps(engine: Engine): EngineContextTypes.ContextCommonDeps {
  return {
    env: engine.env,
    logger: engine.logger,
    platform: engine.platform,
    waitUntilImpl: engine.waitUntilImpl,
    requireStorage: () => engine.requireStorage(),
    requireTimers: () => engine.requireTimers(),
    scheduleTask: (taskId, time, data) => engine.scheduleTask(taskId, time, data),
    cancelScheduled: (taskId, filter) => engine.cancelScheduled(taskId, filter),
    broadcastToConnections: (connections, event, payload, options, excludeConnectionId) => {
      engine.broadcastToConnections(connections, event, payload, options, excludeConnectionId);
    },
    sendThroughPipeline: (connection, routing, event, payload) => {
      return engine.sendThroughPipeline(connection, routing, event, payload);
    },
    broadcastToChannel: (
      channelName,
      event,
      payload,
      excludeConnectionId,
      channelScope,
      excludeSelf,
    ) => {
      engine.broadcastToChannel(
        channelName,
        event,
        payload,
        excludeConnectionId,
        channelScope,
        excludeSelf,
      );
    },
    getChannelMembers: (channelName) => engine.getChannelMembers(channelName),
    kickChannelMembers: (channelName, tag, reason) => {
      engine.kickChannelMembers(channelName, tag, reason);
    },
    sendReplay: (connection, channelName, channelScope, event, payload, wire) => {
      engine.sendReplay(connection, channelName, channelScope, event, payload, wire);
    },
    sendProtocolMessage: (connection, event, payload) => {
      engine.sendProtocolMessage(connection, event, payload);
    },
    persistAttachment: (connection) => engine.persistAttachment(connection),
    toConnectionInfo: (connection) => engine.toConnectionInfo(connection),
    attachModuleApis: (ctx, connection) => engine.attachModuleApis(ctx, connection),
    contextExtenders: engine.hooks.contextExtenders,
  };
}

// ─────── Section: outgoing runtime bag ───────

/**
 * Build the dependency bag used by helpers that only care about outgoing
 * message processing.
 */
export function outgoingRuntime(engine: Engine) {
  return {
    compiled: engine.compiled,
    moduleRuntimes: engine.moduleRuntimes,
    outgoingHooks: engine.hooks.outgoing,
    beforeSendHooks: engine.hooks.beforeSend,
    afterSendHooks: engine.hooks.afterSend,
    waitUntil: (promise: Promise<unknown>) => engine.waitUntilImpl(promise),
    logger: engine.logger,
    generateId: (prefix?: string) => engine.generateId(prefix),
    activityHooks: engine.hooks.activity,
  };
}

// ─────── Section: member runtime bag ───────

/**
 * Build the dependency bag used by helpers that also need live connection and
 * channel membership data.
 */
export function memberRuntime(engine: Engine) {
  return {
    ...outgoingRuntime(engine),
    connections: engine.connections,
    toConnectionInfo: (connection: RuntimeConnection) => engine.toConnectionInfo(connection),
    sendThroughPipeline: (
      connection: RuntimeConnection,
      routing: RoutingTarget | undefined,
      event: string,
      payload: unknown,
    ) => engine.sendThroughPipeline(connection, routing, event, payload),
  };
}

// ─────── Section: channel runtime bag ───────

/**
 * Build the dependency bag used by channel subscribe and unsubscribe helpers.
 */
export function channelRuntime(engine: Engine) {
  return {
    ...memberRuntime(engine),
    beforeSubscribeHooks: engine.hooks.beforeSubscribe,
    subscribeHooks: engine.hooks.subscribe,
    unsubscribeHooks: engine.hooks.unsubscribe,
    broadcastToChannel: (
      channelName: string,
      event: string,
      payload: unknown,
      excludeConnectionId?: string,
      channelScope?: string,
      excludeSelf?: boolean,
    ) => {
      EngineMessageRuntime.broadcastToChannel(
        dispatchRuntime(engine),
        channelName,
        event,
        payload,
        excludeConnectionId,
        channelScope,
        excludeSelf,
      );
    },
    buildConnectionContext: (connection: RuntimeConnection, scope?: ResolvedScope) => {
      return engine.buildConnectionContext(connection, scope);
    },
    persistAttachment: (connection: RuntimeConnection) => engine.persistAttachment(connection),
    sendProtocolMessage: (
      connection: RuntimeConnection,
      event: string,
      payload: Record<string, unknown>,
    ) => engine.sendProtocolMessage(connection, event, payload),
    handleValidationError: (
      connection: RuntimeConnection,
      event: string,
      validationError: unknown,
      scope?: ResolvedScope,
    ) => engine.handleValidationError(connection, event, validationError, scope),
  };
}

// ─────── Section: dispatch runtime bag ───────

/**
 * Build the dependency bag used by inbound text-message dispatch.
 */
export function dispatchRuntime(engine: Engine) {
  return {
    ...memberRuntime(engine),
    logger: engine.logger,
    activeStreams: engine.activeStreams,
    protocolHandlers: engine.hooks.protocol,
    incomingHooks: engine.hooks.incoming,
    errorHooks: engine.hooks.error,
    incomingDedupCap: engine.incomingDedupCap,
    requireTimers: () => engine.requireTimers(),
    buildConnectionContext: (connection: RuntimeConnection, scope?: ResolvedScope) => {
      return engine.buildConnectionContext(connection, scope);
    },
    sendProtocolMessage: (
      connection: RuntimeConnection,
      event: string,
      payload: Record<string, unknown>,
    ) => engine.sendProtocolMessage(connection, event, payload),
    sendReplay: (
      connection: RuntimeConnection,
      channelName: string | undefined,
      channelScope: string | undefined,
      event: string,
      payload: unknown,
      wire: { seq: number; messageId: string; channel?: string },
    ) => engine.sendReplay(connection, channelName, channelScope, event, payload, wire),
    persistAttachment: (connection: RuntimeConnection) => engine.persistAttachment(connection),
    setActiveConnectionId: (value?: string) => {
      engine.activeConnectionId = value;
    },
    handleRuntimeError: (
      connection: RuntimeConnection,
      error: unknown,
      event?: string,
      routing?: Record<string, unknown>,
    ) => engine.handleRuntimeError(connection, error, event, routing),
    handleValidationError: (
      connection: RuntimeConnection,
      event: string,
      validationError: unknown,
      scope?: ResolvedScope,
    ) => engine.handleValidationError(connection, event, validationError, scope),
    broadcastToConnections: (
      connections: readonly RuntimeConnection[],
      event: string,
      payload: unknown,
      options?: BroadcastOptions & { namespace?: string },
      excludeConnectionId?: string,
    ) => engine.broadcastToConnections(connections, event, payload, options, excludeConnectionId),
    handleSubscribe: (
      connection: RuntimeConnection,
      payload: Record<string, unknown> | undefined,
    ) => engine.handleSubscribe(connection, payload),
    handleUnsubscribe: (
      connection: RuntimeConnection,
      payload: Record<string, unknown> | undefined,
    ) => engine.handleUnsubscribe(connection, payload),
  };
}

// ─────── Section: connection runtime bag ───────

/**
 * Build the dependency bag used by connection accept, wake, and close logic.
 */
export function connectionRuntime(engine: Engine) {
  return {
    compiled: engine.compiled,
    timers: engine.timers,
    connections: engine.connections,
    wsToConnectionId: engine.wsToConnectionId,
    generateId: (prefix?: string) => engine.generateId(prefix),
    persistAttachment: (connection: RuntimeConnection) => engine.persistAttachment(connection),
    buildConnectionContext: (connection: RuntimeConnection, scope?: ResolvedScope) => {
      return engine.buildConnectionContext(connection, scope);
    },
    runConnectionLifecycle: (kind: 'connect' | 'disconnect', ctx: Record<PropertyKey, unknown>) => {
      return engine.runConnectionLifecycle(kind, ctx);
    },
    processTextMessage: (connection: RuntimeConnection, data: string) => {
      return engine.processTextMessage(connection, data);
    },
    handleBinaryMessage: (connection: RuntimeConnection, data: ArrayBuffer) => {
      return engine.handleBinaryMessage(connection, data);
    },
    handleConnectionClose: (connection: RuntimeConnection, code: number, reason: string) => {
      return engine.handleConnectionClose(connection, code, reason);
    },
    handleRuntimeError: (connection: RuntimeConnection, error: unknown, event?: string) => {
      return engine.handleRuntimeError(connection, error, event);
    },
  };
}
