/* oxlint-disable @typescript-eslint/no-explicit-any */
import { getInvocationScope } from '~/_engine/async-context.ts';
import { sendProtocolMessage, sendReplay } from '~/_engine/runtime/wire.ts';
import * as KeepalivePrimitive from '~/keepalive/runtime.ts';
import * as OutgoingRuntime from '~/outgoing/runtime.ts';
import type * as EngineAccessModule from '~/_engine/access.ts';
import type { EngineCore } from '~/_engine/core.ts';

/** Callbacks engine-access can't build itself. Supplied by the facade. */
export interface EngineAccessDeps {
  /** Install the scheduled runtime if not already installed. */
  ensureScheduledRuntime(): void;
  /** Build a fresh task context for scheduled task handlers. */
  createTaskContext(): unknown;
  /** Recompute the next scheduled callback from the queued-run table. */
  rescheduleAlarm(): void;
  /**
   * Build the context object for the connection whose dispatch is running right
   * now, or `undefined` when no connection is active (e.g. a fan-out broadcast
   * prepared once for many peers).
   */
  buildCurrentContext(): unknown;
  /** Send a server→client request frame through the outgoing pipeline. */
  sendServerRequest(
    connectionId: string,
    opts: {
      event: string;
      payload: unknown;
      correlationId: string;
      channel?: string;
      channelScope?: string | null;
    },
  ): boolean;
  /** Send a server→client ack-required frame through the outgoing pipeline. */
  sendServerWithAck(
    connectionId: string,
    opts: {
      event: string;
      payload: unknown;
      ackId: string;
      channel?: string;
      channelScope?: string | null;
    },
  ): boolean;
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
    onIncoming: (handler) => {
      core.hooks.incoming.push(handler);
    },
    onAnswerFrame: (handler) => {
      core.hooks.answerFrame.push(handler);
    },
    sendServerRequest: (connectionId, opts) => deps.sendServerRequest(connectionId, opts),
    onAckFrame: (handler) => {
      core.hooks.ackFrame.push(handler);
    },
    sendServerWithAck: (connectionId, opts) => deps.sendServerWithAck(connectionId, opts),
    onOutgoing: (handler, owner) => {
      // The pipeline supplies the frame; ctx is resolved per-send from the
      // active connection, or undefined when none is in scope (broadcasts).
      core.hooks.outgoing.push({
        handler: (frame) => handler(deps.buildCurrentContext(), frame),
        owner: owner ?? OutgoingRuntime.APP_HOOK_OWNER,
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
    requireStorage: () => core.requireStorage(),
    requireTimers: () => core.requireTimers(),
    getInvocationScope: () => getInvocationScope(core.asyncContext),
    setHibernationEnabled: (enabled) => {
      core.hibernationEnabled = enabled;
    },
    setReplayEnabled: (enabled) => {
      core.replayEnabled = enabled;
    },
    setSequencePersistent: (enabled) => {
      core.sequencePersistent = enabled;
    },
    setPersistenceEnabled: (enabled) => {
      core.persistenceEnabled = enabled;
    },
    setChannelPersistent: (channelKey, enabled) => {
      core.channelPersistenceOverrides.set(channelKey, enabled);
    },
    registerPluginApi: (id, factory) => {
      if (core.pluginApiFactories.has(id)) {
        throw new Error(
          `[wskit] Plugin id '${id}' is registered more than once. Each plugin id must be unique.`,
        );
      }
      core.pluginApiFactories.set(id, factory);
    },
    registerPluginLifecycle: (kind, pluginId, handler) => {
      const list = core.hooks.pluginLifecycle[kind];
      list.push({ pluginId, order: list.length, handler });
    },
    registerPluginUpgrade: (pluginId, handler) => {
      core.hooks.pluginUpgrade.push({ pluginId, handler });
    },
    registerTagGroups: (kind, groups) => {
      if (core.tagGroupsRegistered[kind]) {
        throw new Error(`[wskit] tagGroups.${kind} declared more than once in this contract.`);
      }
      core.tagGroupsRegistered[kind] = true;
      if (kind === 'persistent' && !core.persistenceEnabled) {
        const sample = groups[0]?.name;
        throw new Error(
          `[wskit] persistent tag group '${sample}' requires persistence. Set 'persistence: true' in your contract, or move '${sample}' to the 'ephemeral' kind.`,
        );
      }
      for (const group of groups) {
        core.declaredTagGroups[kind].add(group.name);
        if (group.schema) core.tagGroupSchemas.set(`${kind}:${group.name}`, group.schema);
      }
    },
    isDurableMembershipPairPersistent: (channelName, channelScope) =>
      core.isDurableMembershipPairPersistent(channelName, channelScope),
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

      KeepalivePrimitive.refreshIdleTimeout(connection, timeoutMs);
    },
    setKeepalivePingInterval: (intervalMs) => {
      core.keepalivePingIntervalMs = intervalMs;
    },
    getScheduledRuns: () => core.scheduledRuns,
    getScheduledDlq: () => core.scheduledDlq,
    getScheduledTask: (taskId) => core.compiled.scheduled.get(taskId),
    getScheduledTasks: () => core.compiled.scheduled.values(),
    createTaskContext: () => deps.createTaskContext(),
    sendReplay: (connectionId, options) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return;
      sendReplay(core, connection, options);
    },
    assertReplaySendContract: (event, payload, routing) => {
      OutgoingRuntime.assertPayloadRecord(payload);
      if (!OutgoingRuntime.isDeclaredOutgoingEvent(core.compiled, event, routing)) {
        throw new Error(`[wskit] Outgoing event "${event}" was not declared in the active scope.`);
      }
    },
    sendAck: (connectionId, ackId) => {
      if (!ackId) return;
      const connection = core.connections.get(connectionId);
      if (!connection) return;
      // The client originated this acked send; this is the server's receipt.
      sendProtocolMessage(core, connection, {
        event: '__ack__',
        payload: {},
        wskit: { ackId, source: 'client' },
      });
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
