import { CloseCodes, StreamAborted, WSKitConfigError } from '@wskit/core';
import { withConnectionContext } from '~/_engine/async-context.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as KeepalivePrimitive from '~/keepalive/runtime.ts';
import * as TagPrimitive from '~/tags/runtime.ts';
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as LifecycleTypes from '~/lifecycle/lifecycle.ts';
import type * as ConnectionStore from './connection-store.ts';
import type * as EngineRuntimeTypes from './types.ts';

/** Matches the wire-level channel-name cap; identity is used the same way. */
const MAX_IDENTITY_LENGTH = 256;

/**
 * Minimal subset of the WebSocket-like object the engine wraps on wake. The
 * descriptor uses `send` and `close` to drive the underlying socket; the
 * per-connection snapshot is loaded via `runtime.restoreAttachment(wsKey)`,
 * which routes through the adapter's hibernation API.
 */
interface HibernatableWebSocket {
  send?(data: string | ArrayBuffer | ArrayBufferView): void;
  close?(code?: number, reason?: string): void;
}

/**
 * Internal dependency bag for connection-focused runtime helpers.
 */
interface ConnectionRuntime {
  compiled: EngineCompileTypes.CompiledServer;

  hibernationEnabled?: boolean;

  /**
   * Keepalive ping interval (ms) for new connections, set by `keepalive()`.
   * `undefined` when no keepalive is configured — the pinger uses its default.
   */
  keepalivePingIntervalMs?: number;

  connections: Map<string, EngineRuntimeTypes.RuntimeConnection>;
  channelMembers: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>;
  tagMembers: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>;
  wsToConnectionId: Map<unknown, string>;

  generateId(prefix?: string): string;

  persistAttachment(connection: EngineRuntimeTypes.RuntimeConnection): void;

  /**
   * Adapter-provided snapshot restore. Returns the tiny correlation payload
   * the engine wrote on the last persist (`{ id }`), or `undefined` when the
   * platform has no record of this socket. Adapters without hibernation
   * support omit this field.
   */
  restoreAttachment?(wsKey: unknown): unknown;

  /**
   * Read the persisted connection row matching the id read from the
   * attachment. `null` when there is no row (e.g. boot-time reconcile already
   * pruned it). Present only for hibernating engines.
   */
  readConnectionState?(connectionId: string): ConnectionStore.StoredConnectionRow | null;

  /** Delete the persisted connection row at real disconnect. */
  deleteConnectionState?(connectionId: string): void;

  buildConnectionContext(
    connection: EngineRuntimeTypes.RuntimeConnection,
    scope?: EngineRuntimeTypes.ResolvedScope,
  ): Record<PropertyKey, unknown>;

  runConnectionLifecycle(
    kind: 'connect' | 'disconnect',
    ctx: Record<PropertyKey, unknown>,
  ): Promise<void>;

  processTextMessage(connection: EngineRuntimeTypes.RuntimeConnection, data: string): Promise<void>;

  handleConnectionClose(
    connection: EngineRuntimeTypes.RuntimeConnection,
    code: number,
    reason: string,
  ): Promise<void>;

  handleRuntimeError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    error: unknown,
    event?: string,
  ): Promise<void>;

  /**
   * Re-subscribe a fresh connection to every persistent channel its identity
   * was in. Present when persistence is enabled; called from
   * `acceptConnection` between the initial row write and `onConnect`.
   */
  autoRejoinIdentity?(connection: EngineRuntimeTypes.RuntimeConnection): Promise<void>;

  logger?: Pick<PublicApi.Logger, 'error'>;

  /**
   * Reload identity-scoped persistent tags into the live index on wake. The
   * hibernation snapshot only carries ephemeral tags. Present only when
   * persistence is enabled.
   */
  reloadPersistentTags?(connection: EngineRuntimeTypes.RuntimeConnection): void;
}

/** Wrap a `RuntimeConnection` into the `ConnectionHandle` callbacks the adapter uses. */
function createHandle(
  runtime: ConnectionRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
): EngineAdapterTypes.ConnectionHandle {
  async function waitForLifecycle(): Promise<void> {
    await connection.lifecycleReady;
  }

  return {
    handleMessage: async (data) => {
      await waitForLifecycle();
      return runtime.processTextMessage(connection, data);
    },
    handleClose: async (code, reason) => {
      await waitForLifecycle();
      return runtime.handleConnectionClose(connection, code, reason);
    },
    handleError: async (error) => {
      await waitForLifecycle();
      return runtime.handleRuntimeError(connection, error, undefined);
    },
  };
}

/**
 * Run connect/disconnect hooks for both the handler and installed plugins.
 */
export async function runConnectionLifecycle(
  runtime: {
    connectHooks: readonly ((ctx: Record<PropertyKey, unknown>) => void | Promise<void>)[];
    disconnectHooks: readonly ((ctx: Record<PropertyKey, unknown>) => void | Promise<void>)[];
    /**
     * New-model plugin connect/disconnect hooks, in registration order. Inbound
     * (`connect`) runs these head-first before the app; outbound (`disconnect`)
     * runs the app first, then these in reverse (LIFO) — the onion. The
     * handlers are already wrapped in a plugin-scoped context.
     */
    pluginConnectHooks?: readonly {
      handler: (ctx: Record<PropertyKey, unknown>) => void | Promise<void>;
    }[];
    pluginDisconnectHooks?: readonly {
      handler: (ctx: Record<PropertyKey, unknown>) => void | Promise<void>;
    }[];
    asyncContext: EngineAsyncContext;
  },
  kind: 'connect' | 'disconnect',
  ctx: Record<PropertyKey, unknown>,
): Promise<void> {
  return withConnectionContext(runtime.asyncContext, String(ctx.id), async () => {
    if (kind === 'connect') {
      // Inbound onion: new-model plugins see the connection before the app.
      for (const entry of runtime.pluginConnectHooks ?? []) {
        await entry.handler(ctx);
      }
      for (const hook of runtime.connectHooks) {
        await hook(ctx);
      }
    } else {
      for (const hook of runtime.disconnectHooks) {
        await hook(ctx);
      }
      // Outbound onion: the app tears down first, then plugins unwind LIFO.
      const disconnects = runtime.pluginDisconnectHooks ?? [];
      for (let i = disconnects.length - 1; i >= 0; i -= 1) {
        await disconnects[i]!.handler(ctx);
      }
    }
  });
}

/**
 * Stop and forget any active streams owned by a connection that is going away.
 *
 * Streams declared with `onDisconnect: 'keep-running'` are left alone — the
 * generator continues producing into storage and a later `__resumeStream__` from
 * the same identity (or any broadcast subscriber) catches up from the buffer.
 */
export async function cancelActiveStreamsForConnection(
  runtime: {
    activeStreams: Map<
      string,
      {
        id: string;
        connectionId: string;
        generator: AsyncGenerator<unknown, void, unknown>;
        closed: boolean;
        onDisconnect?: EngineRuntimeTypes.OnDisconnect;
        detached?: boolean;
        abortController?: AbortController;
      }
    >;
    logger?: Pick<PublicApi.Logger, 'error'>;
  },
  connectionId: string,
): Promise<void> {
  for (const activeStream of [...runtime.activeStreams.values()]) {
    if (activeStream.connectionId !== connectionId) continue;
    if (activeStream.onDisconnect === 'keep-running') {
      activeStream.detached = true;
      continue;
    }
    activeStream.closed = true;
    // Fire the stop signal before return() so slow awaited work tied to
    // ctx.stream.signal stops first; the generator's finally still runs.
    if (activeStream.abortController && !activeStream.abortController.signal.aborted) {
      activeStream.abortController.abort('aborted');
    }
    try {
      // A user-supplied generator may throw from its `finally` block. Log
      // and move on — the rest of connection-close cleanup (running
      // disconnect hooks, leaving channels, clearing timers, deleting the
      // connection from the runtime maps) must still happen even when one
      // stream's teardown blows up.
      await activeStream.generator.return(undefined);
    } catch (error) {
      runtime.logger?.error('[wskit] stream cleanup threw on connection close', {
        streamId: activeStream.id,
        connectionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      runtime.activeStreams.delete(activeStream.id);
    }
  }
}

export interface HandleConnectionCloseOptions {
  connection: EngineRuntimeTypes.RuntimeConnection;

  code: number;

  reason: string;
}

/**
 * Perform full close cleanup for a connection, including lifecycle hooks and
 * channel leaves.
 */
export async function handleConnectionClose(
  runtime: Pick<
    ConnectionRuntime,
    'compiled' | 'connections' | 'tagMembers' | 'wsToConnectionId' | 'deleteConnectionState'
  > & {
    cancelActiveStreamsForConnection(connectionId: string): Promise<void>;
    buildConnectionContext(
      connection: EngineRuntimeTypes.RuntimeConnection,
      scope?: EngineRuntimeTypes.ResolvedScope,
    ): Record<PropertyKey, unknown>;
    runConnectionLifecycle(
      kind: 'connect' | 'disconnect',
      ctx: Record<PropertyKey, unknown>,
    ): Promise<void>;
    leaveChannel(
      connection: EngineRuntimeTypes.RuntimeConnection,
      opts: ChannelPrimitive.LeaveChannelOptions,
    ): Promise<void>;
    logger?: Pick<PublicApi.Logger, 'error'>;
  },
  options: HandleConnectionCloseOptions,
): Promise<void> {
  const { connection, code, reason } = options;
  // Idempotency guard. handleShutdown drives this directly so the close
  // cleanup completes before shutdown returns; the adapter's natural
  // webSocketClose callback may then fire a second time for the same
  // connection. Re-running the lifecycle would double-fire onDisconnect
  // and rebroadcast __memberLeave__ to peers. Bail when the connection has
  // already been removed from the live set.
  if (!runtime.connections.has(connection.id)) return;

  await runtime.cancelActiveStreamsForConnection(connection.id);

  connection.closing = true;
  runtime.connections.delete(connection.id);
  runtime.wsToConnectionId.delete(connection.wsKey);
  runtime.deleteConnectionState?.(connection.id);

  // Inject the WebSocket close code and reason onto the disconnect ctx
  // so user code can branch on graceful (1000) vs kick (4xxx) vs
  // abnormal (1006). These fields are only set on the disconnect path —
  // the connect ctx never carries them.
  const ctx = runtime.buildConnectionContext(connection);
  ctx.closeCode = code;
  ctx.closeReason = reason;
  try {
    // A user-supplied onDisconnect hook (or a plugin's onDisconnect) may
    // throw. Contain the throw so the rest of the close cleanup —
    // channel leaves (which broadcast `__memberLeave__` to peers), keepalive
    // timer teardown — still runs. Otherwise channel members never see
    // the leave and timers leak.
    await runtime.runConnectionLifecycle('disconnect', ctx);
    /* oxlint-disable-next-line @typescript-eslint/no-unused-vars */
  } catch (error) {
    runtime.logger?.error('[wskit] disconnect lifecycle hook threw', {
      connectionId: connection.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  for (const membership of ChannelPrimitive.listChannelMemberships(connection)) {
    const resolved = ChannelPrimitive.resolveCompiledChannel(
      runtime.compiled,
      membership.channelName,
      membership.channelScope,
    );
    // leaveChannel already contains user-hook throws. This outer guard is
    // defense-in-depth: any unexpected throw from broadcast or persist on
    // one membership must not block later memberships from leaving and
    // must not block keepalive cleanup below.
    try {
      await runtime.leaveChannel(connection, {
        channel: resolved,
        channelName: membership.channelName,
        channelScope: membership.channelScope,
        kickedReason: undefined,
        // disconnect: socket-close path. Persistent channels keep their
        // durable rows so the user is auto-rejoined on next connect.
        disconnect: true,
      });
    } catch (error) {
      runtime.logger?.error('[wskit] leaveChannel threw during close', {
        connectionId: connection.id,
        channel: membership.channelName,
        channelScope: membership.channelScope,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  TagPrimitive.removeConnectionFromTagIndex(runtime.tagMembers, connection);

  if (connection.keepaliveTimer !== undefined) {
    clearTimeout(connection.keepaliveTimer as ReturnType<typeof setTimeout>);
    connection.keepaliveTimer = undefined;
  }

  if (connection.deferTimers) {
    for (const timer of connection.deferTimers) clearTimeout(timer);
    connection.deferTimers.clear();
  }

  KeepalivePrimitive.stopConnectionPing(connection);
}

/**
 * Create runtime state for a newly accepted connection and return the adapter
 * callbacks that feed events into the engine.
 */
export function acceptConnection(
  runtime: ConnectionRuntime,
  wsKey: unknown,
  descriptor: EngineAdapterTypes.ConnectionDescriptor,
): EngineAdapterTypes.ConnectionHandle {
  // identity becomes the durable row key for per-user state, so cap it like a
  // wire field. Reject rather than truncate — two distinct long identities
  // truncated to the same prefix would silently share durable state.
  if (descriptor.identity.length > MAX_IDENTITY_LENGTH) {
    throw new WSKitConfigError(
      `[wskit] identity returned from onUpgrade is ${descriptor.identity.length} chars; the max is ${MAX_IDENTITY_LENGTH}. Use a stable id (user id, ULID) rather than a token as the identity.`,
    );
  }

  const connection: EngineRuntimeTypes.RuntimeConnection = {
    id: runtime.generateId('conn'),
    identity: descriptor.identity,
    wsKey,
    descriptor,
    meta: descriptor.meta ?? {},

    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),

    latency: null,
    quality: 'good',
  };

  for (const ref of descriptor.tags ?? []) {
    if (ref.kind !== 'ephemeral') continue;
    TagPrimitive.addConnectionTag(runtime.tagMembers, connection, {
      kind: 'ephemeral',
      group: ref.group,
      key: ref.key,
    });
  }

  runtime.connections.set(connection.id, connection);
  runtime.wsToConnectionId.set(wsKey, connection.id);
  // Initial write goes through without the gate so the row exists from the
  // moment the connection is live. Then the gate is set so onConnect state
  // changes (channel subscribes, ephemeral tag adds, etc.) batch into one
  // flush after the hook resolves.
  runtime.persistAttachment(connection);
  connection.pendingWrites = { active: true };

  if (!runtime.hibernationEnabled) {
    KeepalivePrimitive.scheduleConnectionPing(connection, runtime.keepalivePingIntervalMs);
  }

  const ctx = runtime.buildConnectionContext(connection);
  // Auto-rejoin runs before onConnect so handlers see the connection already
  // back in its persistent channels. The branch keeps the synchronous start of
  // `runConnectionLifecycle` for engines without persistence — an unconditional
  // `.then()` chain would shift onConnect's timing by a microtask.
  const lifecyclePromise = runtime.autoRejoinIdentity
    ? runtime
        .autoRejoinIdentity(connection)
        .catch((error) => {
          // A rejoin failure (e.g. a storage hiccup) must not skip onConnect.
          // Log it and still run the connect lifecycle so the handler fires.
          runtime.logger?.error('[wskit] auto-rejoin failed; running onConnect anyway', {
            connectionId: connection.id,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .then(() => runtime.runConnectionLifecycle('connect', ctx))
    : runtime.runConnectionLifecycle('connect', ctx);

  connection.lifecycleReady = lifecyclePromise
    .catch((error) => runtime.handleRuntimeError(connection, error, undefined))
    .finally(() => {
      // Flush the buffered state once, even if onConnect threw — the
      // current in-memory state is what the row should reflect.
      if (connection.pendingWrites) {
        connection.pendingWrites.active = false;
        connection.pendingWrites = undefined;
      }
      runtime.persistAttachment(connection);
    });

  return createHandle(runtime, connection);
}

/**
 * Recreate a connection handle after an adapter wakes a hibernated socket.
 */
export function wakeHibernatedConnection(
  runtime: ConnectionRuntime,
  wsKey: unknown,
): EngineAdapterTypes.ConnectionHandle {
  const existingId = runtime.wsToConnectionId.get(wsKey);
  if (existingId) {
    const existing = runtime.connections.get(existingId)!;
    return createHandle(runtime, existing);
  }

  const wsLike = wsKey as HibernatableWebSocket;
  // The attachment now carries a tiny correlation payload — just the
  // connection id — so the engine can find the full state row in SQL. Falls
  // back to a generated id when there is nothing to read (defensive: a
  // missing attachment means the row is gone too, so this socket becomes a
  // fresh connection with empty state instead of crashing on wake).
  const attachment = runtime.restoreAttachment ? runtime.restoreAttachment(wsKey) : undefined;
  const attachmentId =
    attachment &&
    typeof attachment === 'object' &&
    typeof (attachment as { id?: unknown }).id === 'string'
      ? (attachment as { id: string }).id
      : undefined;

  const row =
    attachmentId && runtime.readConnectionState ? runtime.readConnectionState(attachmentId) : null;

  const id = row?.connection_id ?? attachmentId ?? runtime.generateId('conn');
  const identity = row?.identity ?? '';
  const meta = row?.meta ?? {};
  const ephemeralRefs: PublicApi.TagRef[] = (row?.ephemeral_tags ?? []).map((t) => ({
    __wskit: 'tag-ref' as const,
    kind: 'ephemeral' as const,
    group: t.group,
    key: t.key,
  }));
  // Both filled after the connection is created so the add* helpers can also
  // repopulate the engine-wide channel and tag member indexes.
  const channelMemberships = new Map<
    string,
    { channelName: string; channelScope: string | null }
  >();
  const restoredStreamIds = row?.active_stream_ids ?? [];

  const descriptor: EngineAdapterTypes.ConnectionDescriptor = {
    send: (data) => wsLike.send?.(data),
    close: (code, reason) => wsLike.close?.(code, reason),
    bufferedAmount: () => 0,
    identity,
    meta,
    tags: ephemeralRefs,
  };

  for (const streamId of restoredStreamIds) {
    descriptor.send(
      JSON.stringify({
        event: '__error__',
        payload: {
          code: StreamAborted.code,
          detail: { reason: 'hibernation-wake' as const },
        },
        __wskit: { streamId },
      }),
    );
  }

  const connection: EngineRuntimeTypes.RuntimeConnection = {
    id,
    identity,
    wsKey,
    descriptor,
    meta,
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships,
    latency: null,
    quality: 'good',
  };

  runtime.connections.set(connection.id, connection);
  runtime.wsToConnectionId.set(wsKey, connection.id);

  for (const t of row?.ephemeral_tags ?? []) {
    TagPrimitive.addConnectionTag(runtime.tagMembers, connection, {
      kind: 'ephemeral',
      group: t.group,
      key: t.key,
    });
  }

  for (const membership of row?.ephemeral_memberships ?? []) {
    ChannelPrimitive.addChannelMembership(runtime.channelMembers, connection, {
      channelName: membership.channelName,
      channelScope: membership.channelScope,
    });
  }

  // The snapshot above only holds ephemeral tags. Persistent tags are
  // identity-scoped, so reload them from durable storage on wake.
  runtime.reloadPersistentTags?.(connection);

  // Re-persist so the row reflects the cleared active_stream_ids (the wake
  // path drained them above) and the attachment carries the correct id
  // even if it was missing before.
  if (restoredStreamIds.length > 0) {
    runtime.persistAttachment(connection);
  }

  if (!runtime.hibernationEnabled) {
    KeepalivePrimitive.scheduleConnectionPing(connection, runtime.keepalivePingIntervalMs);
  }

  connection.lifecycleReady = Promise.resolve();

  return createHandle(runtime, connection);
}

/**
 * Run the optional upgrade hook and normalize its result into adapter-friendly
 * accept/reject data.
 */
export async function handleUpgrade(
  runtime: {
    upgradeHooks: readonly ((
      request: Request,
      helpers: LifecycleTypes.UpgradeHelpers,
    ) =>
      | { meta?: Record<string, unknown>; tags?: readonly PublicApi.TagRef[] }
      | Promise<{
          meta?: Record<string, unknown>;
          tags?: readonly PublicApi.TagRef[];
        }>)[];
    /**
     * New-model plugin `upgrade` hooks, in registration order. Run before the
     * app's builder hook (inbound onion). Each may own `identity`, but the
     * single-owner rule below allows at most one identity source overall.
     */
    pluginUpgradeHooks?: readonly {
      pluginId: string;
      handler: (
        request: Request,
        helpers: LifecycleTypes.UpgradeHelpers,
      ) =>
        | { identity?: string; meta?: Record<string, unknown>; tags?: readonly PublicApi.TagRef[] }
        | Promise<{
            identity?: string;
            meta?: Record<string, unknown>;
            tags?: readonly PublicApi.TagRef[];
          }>;
    }[];
    builderUpgradeHook?:
      | ((
          request: Request,
          helpers: LifecycleTypes.UpgradeHelpers,
        ) =>
          | {
              identity?: string;
              meta?: Record<string, unknown>;
              tags?: readonly PublicApi.TagRef[];
            }
          | Promise<{
              identity?: string;
              meta?: Record<string, unknown>;
              tags?: readonly PublicApi.TagRef[];
            }>)
      | undefined;
    /**
     * Built once per engine. A contract with `tagGroups` populates the field;
     * contracts without tag groups pass `undefined` and the helper bag is the
     * empty object.
     */
    upgradeHelpers: LifecycleTypes.UpgradeHelpers;
    /**
     * Whether a tag group of the given kind was declared. Guards tag refs an
     * upgrade returns — including the `tags: { ephemeral: { ... } }` sugar,
     * which builds refs without going through the declaration-checked helper.
     */
    isTagGroupDeclared(kind: 'ephemeral' | 'persistent', group: string): boolean;
  },
  request: Request,
): Promise<EngineAdapterTypes.UpgradeDecision> {
  const pluginUpgradeHooks = runtime.pluginUpgradeHooks ?? [];
  if (
    pluginUpgradeHooks.length === 0 &&
    runtime.upgradeHooks.length === 0 &&
    !runtime.builderUpgradeHook
  ) {
    return {};
  }

  try {
    // Onion order: plugin upgrades first (registration order), then internal
    // primitive hooks, then the app's builder hook last. Each result's meta is
    // shallow-merged into the running total — since the app applies last it
    // wins on key conflict; tags are concatenated (TagRef equality is by
    // identity). At most one hook may own `identity`.
    let mergedMeta: Record<string, unknown> | undefined;
    let builderIdentity: string | undefined;
    let identityOwner: string | undefined;
    const mergedTags: PublicApi.TagRef[] = [];
    function apply(
      result: {
        identity?: string;
        meta?: Record<string, unknown>;
        tags?: readonly PublicApi.TagRef[];
      },
      owner: string,
    ): void {
      if (result.identity !== undefined) {
        if (identityOwner !== undefined) {
          throw new Error(
            `[wskit] Two upgrade hooks returned 'identity' (${identityOwner} and ${owner}). ` +
              'identity has exactly one owner per connection — the app or one plugin, never both.',
          );
        }
        identityOwner = owner;
        builderIdentity = result.identity;
      }
      if (result.meta) {
        mergedMeta = mergedMeta ? { ...mergedMeta, ...result.meta } : { ...result.meta };
      }
      if (result.tags) {
        for (const ref of result.tags) {
          if (ref.kind === 'persistent') {
            throw new Error(
              `[wskit] onUpgrade returned a persistent tag ref for group '${ref.group}'. Persistent tags must be added at runtime via ctx.tags.persistent('${ref.group}').add(...).`,
            );
          }
          if (!runtime.isTagGroupDeclared('ephemeral', ref.group)) {
            throw new Error(
              `[wskit] onUpgrade returned an ephemeral tag for group '${ref.group}', which is not declared under tags (ephemeral). Add it to the tags(...) capability or check for a typo.`,
            );
          }
          mergedTags.push(ref);
        }
      }
    }
    for (const entry of pluginUpgradeHooks) {
      apply(
        (await entry.handler(request, runtime.upgradeHelpers)) ?? {},
        `plugin '${entry.pluginId}'`,
      );
    }
    for (const hook of runtime.upgradeHooks) {
      apply((await hook(request, runtime.upgradeHelpers)) ?? {}, 'an internal hook');
    }
    if (runtime.builderUpgradeHook) {
      apply((await runtime.builderUpgradeHook(request, runtime.upgradeHelpers)) ?? {}, 'the app');
    }
    return {
      identity: builderIdentity,
      meta: mergedMeta,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
    };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (error as { __wskit?: string }).__wskit === 'reject-upgrade'
    ) {
      return {
        reject: true,
        code: (error as { code: number }).code,
        reason: (error as { reason: string }).reason,
      };
    }

    return {
      reject: true,
      code: 500,
      reason: 'Upgrade failed',
    };
  }
}

/**
 * Shut down the engine, plugin hooks, active streams, and open connections.
 */
export async function handleShutdown(
  runtime: Pick<ConnectionRuntime, 'connections'> & {
    activeStreams?: ReadonlyMap<string, { abortController?: AbortController }>;
    shutdownHooks: readonly ((ctx: unknown) => void | Promise<void>)[];
    /**
     * New-model plugin shutdown hooks, in registration order. Run after the
     * app's, in reverse (LIFO) — the outbound onion. Already scoped.
     */
    pluginShutdownHooks?: readonly { handler: (ctx: unknown) => void | Promise<void> }[];
    createShutdownContext(): unknown;
    cancelActiveStreamsForConnection(connectionId: string): Promise<void>;
    handleConnectionClose(connection: EngineRuntimeTypes.RuntimeConnection): Promise<void>;
    alarmState: { current: unknown | null };
    logger?: Pick<PublicApi.Logger, 'error'>;
  },
): Promise<void> {
  // Fire every active stream's stop signal up front — including detached
  // keep-running streams that the per-connection close below leaves alone — so
  // in-flight awaited work tied to ctx.stream.signal stops as the server goes
  // away. Idempotent: the per-connection close re-checks before aborting.
  if (runtime.activeStreams) {
    for (const activeStream of runtime.activeStreams.values()) {
      if (activeStream.abortController && !activeStream.abortController.signal.aborted) {
        activeStream.abortController.abort('shutdown');
      }
    }
  }

  // Shutdown is a best-effort drain: a throwing hook must not block
  // stream cancellation, socket close, or alarm clear. Each hook runs
  // inside its own try/catch with logging; cleanup below always runs.
  for (const hook of runtime.shutdownHooks) {
    try {
      await hook(runtime.createShutdownContext());
    } catch (error) {
      runtime.logger?.error('[wskit] shutdown hook threw', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Outbound onion: new-model plugins unwind after the app, LIFO.
  const pluginShutdowns = runtime.pluginShutdownHooks ?? [];
  for (let i = pluginShutdowns.length - 1; i >= 0; i -= 1) {
    try {
      await pluginShutdowns[i]!.handler(runtime.createShutdownContext());
    } catch (error) {
      runtime.logger?.error('[wskit] plugin shutdown hook threw', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Snapshot the live set before closing — handleConnectionClose
  // mutates the connections map, and the natural webSocketClose chain
  // triggered by descriptor.close also enters this code path. Iterating
  // a snapshot keeps the work deterministic.
  const draining = [...runtime.connections.values()];

  // Send the wire-level close frame first so clients see GOING_AWAY
  // promptly, then drive the per-connection cleanup chain ourselves
  // (onDisconnect hooks, __memberLeave__ broadcasts, channel leaves,
  // keepalive timer teardown). The cleanup must be awaited so the adapter
  // instance is not evicted before it lands and leaves channel peers with
  // ghost members.
  for (const connection of draining) {
    connection.descriptor.close(CloseCodes.GOING_AWAY, 'Server shutting down');
  }
  await Promise.all(
    draining.map(async (connection) => {
      try {
        await runtime.handleConnectionClose(connection);
      } catch (error) {
        runtime.logger?.error('[wskit] handleConnectionClose threw during shutdown', {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  if (runtime.alarmState.current !== null) {
    clearTimeout(runtime.alarmState.current as ReturnType<typeof setTimeout>);
    runtime.alarmState.current = null;
  }
}
