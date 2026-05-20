/* oxlint-disable @typescript-eslint/no-explicit-any */
import { sendProtocolMessage, sendReplay } from '~/_engine/runtime/wire.ts';
import * as HeartbeatPrimitive from '~/heartbeat/runtime.ts';
import * as OutgoingRuntime from '~/outgoing/runtime.ts';
import type * as EngineAccessModule from '~/_engine/access.ts';
import type { EngineCore } from '~/_engine/core.ts';

/** Callbacks engine-access can't build itself. Supplied by the facade. */
export interface EngineAccessDeps {
  /** Install the scheduled runtime if not already installed. */
  ensureScheduledRuntime(): void;
  /** Build a fresh task context for scheduled task handlers. */
  createTaskContext(): unknown;
  /** Recompute the next adapter alarm from the queued-run table. */
  rescheduleAlarm(): void;
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
    onIncoming: (handler) => {
      core.hooks.incoming.push(handler);
    },
    onOutgoing: (handler) => {
      core.hooks.outgoing.push(handler);
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
    onBinary: (handler) => {
      core.hooks.binary.push(handler);
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
    onBeforeSubscribe: (handler, validator) => {
      pushChannelHook(
        core.hooks.beforeSubscribe,
        scope?.channelKey,
        { handler, validator },
        'onBeforeSubscribe',
      );
    },
    onSubscribe: (handler) => {
      pushChannelHook(core.hooks.subscribe, scope?.channelKey, handler, 'onSubscribe');
    },
    onUnsubscribe: (handler) => {
      pushChannelHook(core.hooks.unsubscribe, scope?.channelKey, handler, 'onUnsubscribe');
    },
    onSessionEnd: (handler) => {
      pushChannelHook(core.hooks.sessionEnd, scope?.channelKey, handler, 'onSessionEnd');
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
    registerTagGroups: (kind, groups) => {
      if (core.tagGroupsRegistered[kind]) {
        throw new Error(
          `[wskit] .tagGroups('${kind}', ...) declared more than once on this builder.`,
        );
      }
      core.tagGroupsRegistered[kind] = true;
      if (kind === 'persistent' && !core.persistenceEnabled) {
        const sample = groups[0];
        throw new Error(
          `[wskit] persistent tag group '${sample}' requires withPersistence and a call to .enablePersistence(). Wrap your server with withPersistence(...) and call .enablePersistence() on the builder, or move '${sample}' to the 'ephemeral' kind.`,
        );
      }
      for (const group of groups) core.declaredTagGroups[kind].add(group);
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

      HeartbeatPrimitive.refreshHeartbeatTimeout(core.requireTimers(), connection, timeoutMs);
    },
    getScheduledRuns: () => core.scheduledRuns,
    getScheduledDlq: () => core.scheduledDlq,
    getScheduledTask: (taskId) => core.compiled.scheduled.get(taskId),
    getScheduledTasks: () => core.compiled.scheduled.values(),
    createTaskContext: () => deps.createTaskContext(),
    sendReplay: (connectionId, channelName, channelScope, event, payload, wire) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return;
      sendReplay(core, connection, channelName, channelScope, event, payload, wire);
    },
    assertReplaySendContract: (event, payload, routing) => {
      OutgoingRuntime.assertPayloadRecord(payload);
      OutgoingRuntime.assertNoReservedPayloadFields(payload);
      if (!OutgoingRuntime.isDeclaredOutgoingEvent(core.compiled, event, routing)) {
        throw new Error(`[wskit] Outgoing event "${event}" was not declared in the active scope.`);
      }
    },
    sendAck: (connectionId) => {
      const connection = core.connections.get(connectionId);
      if (!connection?.activeAckId) return;
      sendProtocolMessage(core, connection, '_ack', { _ackId: connection.activeAckId });
    },
    rescheduleAlarm: () => deps.rescheduleAlarm(),
    generateId: (prefix) => core.generateId(prefix),
    waitUntil: (promise) => {
      core.waitUntilImpl(promise);
    },
    rawSend: (connectionId, event, payload) => {
      const connection = core.connections.get(connectionId);
      if (!connection) return;
      sendProtocolMessage(core, connection, event, payload as Record<string, unknown>);
    },
  };
}

/**
 * Add one hook to a channel-scoped registry. Throws if called outside
 * `channel(...)` since the hook needs a channel key to land under.
 */
function pushChannelHook<T>(
  hooks: Map<string, T[]>,
  channelKey: string | undefined,
  hook: T,
  hookName: 'onBeforeSubscribe' | 'onSubscribe' | 'onUnsubscribe' | 'onSessionEnd',
): void {
  if (!channelKey) {
    throw new Error(`[wskit] ${hookName}() can only be registered inside channel(...).`);
  }

  const existing = hooks.get(channelKey) ?? [];
  existing.push(hook);
  hooks.set(channelKey, existing);
}
