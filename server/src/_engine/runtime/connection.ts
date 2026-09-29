import {
  assertSynchronousResult,
  CloseCodes,
  isLiveThingConfigError,
  LiveThingConfigError,
  StreamAborted,
} from '@livething/core';
import { normalizeConnectionDescriptor } from '~/_adapters/close.ts';
import { connectionCall, withCallContext, withConnectionCall } from '~/_engine/async-context.ts';
import { isValidCloseCode } from '~/_engine/close-code.ts';
import { validateValue } from '~/_engine/compile/utils.ts';
import { addConnectionTag, removeConnectionFromTagIndex } from '~/_engine/runtime/tag-index.ts';
import { assertUsableUserId, userKeyOf } from '~/_engine/runtime/user-key.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import { isTranslatorConfigError, markTranslatorConfigError } from '~/translation/error.ts';
import { TranslationInputError } from '~/translation/translator.ts';
import type * as EngineAdapterTypes from '~/_adapters/types.ts';
import type { EngineAsyncContext } from '~/_engine/async-context.ts';
import type { CallDescriptor } from '~/_engine/call-context.ts';
import type * as EngineCompileTypes from '~/_engine/compile/types.ts';
import type * as PublicApi from '~/context.ts';
import type * as LifecycleTypes from '~/lifecycle/lifecycle.ts';
import type { Translator, TranslatorFactory } from '~/translation/translator.ts';
import { serializeWireFrame } from './wire-serialize.ts';
import type * as ConnectionStore from './connection-store.ts';
import type * as EngineRuntimeTypes from './types.ts';

type RunConnectionLifecycleRuntimeParameter = {
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
};
type CancelActiveStreamsForConnectionRuntimeParameter = {
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
};
type HandleUpgradeRuntimeParameter = {
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
   * app's builder hook (inbound onion). Each may own `userId`, but the
   * single-owner rule below allows at most one user id source overall.
   */
  pluginUpgradeHooks?: readonly {
    pluginId: string;
    handler: (
      request: Request,
      helpers: LifecycleTypes.UpgradeHelpers,
    ) =>
      | { userId?: string; meta?: Record<string, unknown>; tags?: readonly PublicApi.TagRef[] }
      | Promise<{
          userId?: string;
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
            userId?: string;
            meta?: Record<string, unknown>;
            tags?: readonly PublicApi.TagRef[];
          }
        | Promise<{
            userId?: string;
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
  /** Lets `context.upgrade(base)` reach the upgrade `ctx`. Omitted by test harnesses. */
  asyncContext?: EngineAsyncContext;
  /**
   * Whether a tag group of the given kind was declared. Guards tag refs an
   * upgrade returns — including the `tags: { ephemeral: { ... } }` sugar,
   * which builds refs without going through the declaration-checked helper.
   */
  isTagGroupDeclared(kind: 'ephemeral' | 'persistent', group: string): boolean;
  /**
   * The schema a tag group declared, or `undefined` for a `t<>()` group. Keys
   * an upgrade returns are checked against it, the same as `add()`.
   */
  getTagGroupSchema(kind: 'ephemeral' | 'persistent', group: string): unknown;
  logger?: Pick<PublicApi.Logger, 'error'>;
};
type ApplyResultParameter = {
  userId?: string;
  meta?: Record<string, unknown>;
  tags?: readonly PublicApi.TagRef[];
};

export { userKeyOf } from '~/_engine/runtime/user-key.ts';

/**
 * Connections that have been told to close by the `replace` eviction path but
 * whose real close event has not landed yet. Keyed by connection identity so
 * admission math for a rapid burst does not count them as still holding a
 * slot, and so the same connection is never asked to close twice.
 */
const pendingEvictions = new WeakSet<EngineRuntimeTypes.RuntimeConnection>();

/**
 * Add one connection to the user-key fan-out index, creating its set if
 * needed. A no-op for an anonymous connection (`userKeyOf` returns `null`) —
 * it has no user identity to fan out to, and must never be reachable via
 * `ctx.user` or `ctx.users.get(...)`.
 */
function addConnectionToUserIndex(
  usersByKey: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>,
  connection: EngineRuntimeTypes.RuntimeConnection,
): void {
  const key = userKeyOf(connection);
  if (key === null) return;

  let members = usersByKey.get(key);
  if (!members) {
    members = new Set();
    usersByKey.set(key, members);
  }

  members.add(connection);
}

/**
 * Remove one connection from the user-key fan-out index, dropping an emptied
 * set. A no-op for an anonymous connection — it was never added.
 */
function removeConnectionFromUserIndex(
  usersByKey: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>,
  connection: EngineRuntimeTypes.RuntimeConnection,
): void {
  const key = userKeyOf(connection);
  if (key === null) return;

  const members = usersByKey.get(key);
  if (!members) return;

  members.delete(connection);

  if (members.size === 0) usersByKey.delete(key);
}

/**
 * Undo the in-memory half of a connection setup that failed after indexing
 * the connection. Wake callers keep durable state so a later boot can retry;
 * accept callers decide separately whether to delete their row.
 */
function rollbackConnectionIndexes(
  runtime: Pick<
    ConnectionRuntime,
    'connections' | 'usersByKey' | 'channelMembers' | 'tagMembers' | 'wsToConnectionId'
  >,
  connection: EngineRuntimeTypes.RuntimeConnection,
): void {
  runtime.connections.delete(connection.id);
  removeConnectionFromUserIndex(runtime.usersByKey, connection);
  runtime.wsToConnectionId.delete(connection.wsKey);

  for (const membership of ChannelPrimitive.listChannelMemberships(connection)) {
    ChannelPrimitive.removeChannelMembership(runtime.channelMembers, connection, membership);
  }

  removeConnectionFromTagIndex(runtime.tagMembers, connection);
}

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

  translatorFactory?: TranslatorFactory;

  connections: Map<string, EngineRuntimeTypes.RuntimeConnection>;
  /** User-key → members index, maintained on accept, close, and hibernation wake. */
  usersByKey: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>;
  channelMembers: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>;
  tagMembers: Map<string, Set<EngineRuntimeTypes.RuntimeConnection>>;
  wsToConnectionId: Map<unknown, string>;

  generateId(prefix?: string): string;

  persistAttachment(connection: EngineRuntimeTypes.RuntimeConnection): void;

  /**
   * Persist immediately, bypassing an invocation scope's end-of-callback batch.
   * Outbound translation needs this before bytes reach the socket so its state
   * snapshot cannot fail after the client has received a translated frame.
   */
  flushAttachment?(connection: EngineRuntimeTypes.RuntimeConnection): void;

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
    scope?: EngineRuntimeTypes.ResolvedChannel,
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
   * Re-subscribe a fresh connection to every persistent channel its user id
   * was in. Called from `acceptConnection` between the initial row write and
   * `onConnect`.
   */
  autoRejoinIdentity?(connection: EngineRuntimeTypes.RuntimeConnection): Promise<void>;

  logger?: Pick<PublicApi.Logger, 'error'>;

  /**
   * Reload a user's persistent tags into the live index on wake. The
   * hibernation snapshot only carries ephemeral tags.
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

  async function reportCallbackError(error: unknown): Promise<void> {
    try {
      await runtime.handleRuntimeError(connection, error, undefined);
    } catch (handlerError) {
      runtime.logger?.error('[livething] connection error handler failed', {
        error: handlerError instanceof Error ? handlerError.message : String(handlerError),
      });
    }
  }

  return {
    handleMessage: async (data) => {
      try {
        await waitForLifecycle();
        const translated = translateInbound(runtime, connection, data);
        if (translated === undefined) return;

        await runtime.processTextMessage(connection, translated);
      } catch (error) {
        if (isTranslatorConfigError(error)) throw error;

        await reportCallbackError(error);
      }
    },
    handleClose: async (code, reason) => {
      try {
        await waitForLifecycle();
        await runtime.handleConnectionClose(connection, code, reason);
      } catch (error) {
        await reportCallbackError(error);
      }
    },
    handleError: async (error) => {
      try {
        await waitForLifecycle();
        await runtime.handleRuntimeError(connection, error, undefined);
      } catch (handlerError) {
        runtime.logger?.error('[livething] connection error handler failed', {
          error: handlerError instanceof Error ? handlerError.message : String(handlerError),
        });
      }
    },
  };
}

function closedHandle(): EngineAdapterTypes.ConnectionHandle {
  return {
    handleMessage: async () => {},
    handleClose: async () => {},
    handleError: async () => {},
  };
}

interface TranslationFailure {
  runtime: Pick<ConnectionRuntime, 'logger'>;
  descriptor: EngineAdapterTypes.ConnectionDescriptor;
  connection?: EngineRuntimeTypes.RuntimeConnection;
  stage: string;
  error: unknown;
  code?: number;
}

function closeForTranslationFailure(failure: TranslationFailure): void {
  const {
    runtime,
    descriptor,
    connection,
    stage,
    error,
    code = CloseCodes.INTERNAL_ERROR,
  } = failure;
  if (connection) connection.closing = true;
  runtime.logger?.error('[livething] translator failed', {
    stage,
    error: error instanceof Error ? error.message : String(error),
  });
  descriptor.close(code, '[livething] translator failed');
}

function rethrowTranslatorConfigError(
  error: unknown,
  descriptor: EngineAdapterTypes.ConnectionDescriptor,
  connection?: EngineRuntimeTypes.RuntimeConnection,
): void {
  if (!isLiveThingConfigError(error)) return;

  // A translator shape error is a developer configuration failure: close the
  // affected connection, then rethrow so the host process can see the error.
  markTranslatorConfigError(error);
  if (connection?.closing) throw error;

  if (connection) {
    connection.closing = true;
    connection.preserveStateOnClose = true;
  }

  descriptor.close(CloseCodes.INTERNAL_ERROR, '[livething] translator configuration failed');
  throw error;
}

function assertTranslator(value: unknown): Translator {
  if (!value || typeof value !== 'object' || typeof (value as Translator).inbound !== 'function') {
    throw new LiveThingConfigError('translator factory did not return inbound(raw).');
  }

  const translator = value as Translator;
  if (translator.outbound !== undefined && typeof translator.outbound !== 'function') {
    throw new LiveThingConfigError('translator outbound must be a function when provided.');
  }

  if (
    translator.hibernation !== undefined &&
    (!translator.hibernation ||
      typeof translator.hibernation !== 'object' ||
      typeof translator.hibernation.serialize !== 'function' ||
      typeof translator.hibernation.restore !== 'function')
  ) {
    throw new LiveThingConfigError(
      'translator hibernation must provide both serialize() and restore().',
    );
  }

  return translator;
}

function createTranslator(
  runtime: Pick<ConnectionRuntime, 'translatorFactory' | 'logger'>,
  descriptor: EngineAdapterTypes.ConnectionDescriptor,
): Translator | null | undefined {
  if (!runtime.translatorFactory) return undefined;

  try {
    return assertTranslator(
      assertSynchronousResult(runtime.translatorFactory(), 'translator factory'),
    );
  } catch (error) {
    rethrowTranslatorConfigError(error, descriptor);
    closeForTranslationFailure({ runtime, descriptor, stage: 'factory', error });
    return null;
  }
}

interface TranslatedDescriptorOptions {
  runtime: ConnectionRuntime;
  descriptor: EngineAdapterTypes.ConnectionDescriptor;
  translator: Translator | undefined;
  getConnection: () => EngineRuntimeTypes.RuntimeConnection | undefined;
}

interface RestoreWakeIndexesInput {
  runtime: ConnectionRuntime;
  connection: EngineRuntimeTypes.RuntimeConnection;
  row: ConnectionStore.StoredConnectionRow | null;
  restoredStreamIds: readonly string[];
}

function translatedDescriptor(
  options: TranslatedDescriptorOptions,
): EngineAdapterTypes.ConnectionDescriptor {
  const { runtime, descriptor, translator, getConnection } = options;
  if (!translator) return descriptor;

  const translated: EngineAdapterTypes.ConnectionDescriptor = {
    send(data) {
      if (getConnection()?.closing) return false;

      let outgoing = data;
      if (translator.outbound) {
        try {
          const translated = assertSynchronousResult(
            translator.outbound(data),
            'translator.outbound',
          );
          if (translated !== null && typeof translated !== 'string') {
            throw new Error('[livething] translator outbound must return a string or null.');
          }

          if (translated !== null) outgoing = translated;
        } catch (error) {
          const connection = getConnection();
          rethrowTranslatorConfigError(error, descriptor, connection);
          closeForTranslationFailure({ runtime, descriptor, connection, stage: 'outbound', error });
          return false;
        }
      }

      try {
        const connection = getConnection();
        if (connection) {
          (runtime.flushAttachment ?? runtime.persistAttachment)(connection);
          if (connection.closing) return false;
        }
      } catch (error) {
        const connection = getConnection();
        rethrowTranslatorConfigError(error, descriptor, connection);
        closeForTranslationFailure({ runtime, descriptor, connection, stage: 'outbound', error });
        return false;
      }

      return descriptor.send(outgoing);
    },
    close(code, reason) {
      descriptor.close(code, reason);
    },
    bufferedAmount() {
      return descriptor.bufferedAmount();
    },
    userId: descriptor.userId,
  };

  if (descriptor.backpressureSupported !== undefined) {
    translated.backpressureSupported = descriptor.backpressureSupported;
  }

  if (descriptor.meta !== undefined) translated.meta = descriptor.meta;

  if (descriptor.tags !== undefined) translated.tags = descriptor.tags;

  return translated;
}

function translateInbound(
  runtime: ConnectionRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
  data: string,
): string | undefined {
  if (connection.closing) return undefined;

  if (!connection.translator) return data;

  try {
    const translated = assertSynchronousResult(
      connection.translator.inbound(data),
      'translator.inbound',
    );
    if (translated !== null && typeof translated !== 'string') {
      throw new Error('[livething] translator inbound must return a string or null.');
    }

    runtime.persistAttachment(connection);
    if (connection.closing) return undefined;

    return translated ?? data;
  } catch (error) {
    rethrowTranslatorConfigError(error, connection.descriptor, connection);
    closeForTranslationFailure({
      runtime,
      descriptor: connection.descriptor,
      connection,
      stage: 'inbound',
      error,
      code:
        error instanceof TranslationInputError
          ? CloseCodes.PROTOCOL_ERROR
          : CloseCodes.INTERNAL_ERROR,
    });
    return undefined;
  }
}

/**
 * Run connect/disconnect hooks for both the handler and installed plugins.
 */
export async function runConnectionLifecycle(
  runtime: RunConnectionLifecycleRuntimeParameter,
  kind: 'connect' | 'disconnect',
  ctx: Record<PropertyKey, unknown>,
): Promise<void> {
  const connectionId = (ctx as { connection?: { id?: string } }).connection?.id ?? '';
  return withConnectionCall(
    runtime.asyncContext,
    connectionCall(connectionId, undefined, () => ctx),
    async () => {
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
    },
  );
}

/**
 * Stop and forget any active streams owned by a connection that is going away.
 *
 * Streams declared with `onDisconnect: 'keep-running'` are left alone — the
 * generator continues producing into storage and a later `__continueStream__` from
 * the same user (or any broadcast subscriber) catches up from the buffer.
 */
export async function cancelActiveStreamsForConnection(
  runtime: CancelActiveStreamsForConnectionRuntimeParameter,
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
      runtime.logger?.error('[livething] stream cleanup threw on connection close', {
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

type ConnectionCloseRuntime = Pick<
  ConnectionRuntime,
  | 'compiled'
  | 'connections'
  | 'usersByKey'
  | 'tagMembers'
  | 'wsToConnectionId'
  | 'deleteConnectionState'
> & {
  cancelActiveStreamsForConnection(connectionId: string): Promise<void>;
  buildConnectionContext(
    connection: EngineRuntimeTypes.RuntimeConnection,
    scope?: EngineRuntimeTypes.ResolvedChannel,
  ): Record<PropertyKey, unknown>;
  runConnectionLifecycle(
    kind: 'connect' | 'disconnect',
    ctx: Record<PropertyKey, unknown>,
  ): Promise<void>;
  leaveChannel(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: ChannelPrimitive.LeaveChannelOptions,
  ): Promise<void>;
  connectionCleanupHooks?: readonly ((connectionId: string) => void)[];
  logger?: Pick<PublicApi.Logger, 'error'>;
};

const runningCloses = new WeakMap<EngineRuntimeTypes.RuntimeConnection, Promise<void>>();

/**
 * Perform full close cleanup for a connection, including lifecycle hooks and
 * channel leaves.
 *
 * handleShutdown drives this directly so the cleanup completes before shutdown
 * returns, and the adapter's own close event may call it again for the same
 * connection, even while the first cleanup is still running. Every call after
 * the first waits for that one cleanup, so onDisconnect and `__memberLeave__`
 * run once.
 */
export function handleConnectionClose(
  runtime: ConnectionCloseRuntime,
  options: HandleConnectionCloseOptions,
): Promise<void> {
  const { connection } = options;
  const running = runningCloses.get(connection);
  if (running) return running;

  if (!runtime.connections.has(connection.id)) return Promise.resolve();

  const cleanup = closeConnection(runtime, options);
  runningCloses.set(connection, cleanup);

  return cleanup;
}

async function closeConnection(
  runtime: ConnectionCloseRuntime,
  options: HandleConnectionCloseOptions,
): Promise<void> {
  const { connection, code, reason } = options;
  await runtime.cancelActiveStreamsForConnection(connection.id);

  connection.closing = true;
  runtime.connections.delete(connection.id);
  removeConnectionFromUserIndex(runtime.usersByKey, connection);
  pendingEvictions.delete(connection);
  runtime.wsToConnectionId.delete(connection.wsKey);

  if (!connection.preserveStateOnClose) {
    runtime.deleteConnectionState?.(connection.id);
  }

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
    runtime.logger?.error('[livething] disconnect lifecycle hook threw', {
      connectionId: connection.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  for (const membership of ChannelPrimitive.listChannelMemberships(connection)) {
    const resolved = ChannelPrimitive.resolveCompiledChannel(
      runtime.compiled,
      membership.channelName,
      membership.channelFamily,
    );
    // leaveChannel already contains user-hook throws. This outer guard is
    // defense-in-depth: any unexpected throw from broadcast or persist on
    // one membership must not block later memberships from leaving and
    // must not block keepalive cleanup below.
    try {
      await runtime.leaveChannel(connection, {
        channel: resolved,
        channelName: membership.channelName,
        channelFamily: membership.channelFamily,
        kickedReason: undefined,
        // disconnect: socket-close path. Persistent channels keep their
        // durable rows so the user is auto-rejoined on next connect.
        disconnect: true,
      });
    } catch (error) {
      runtime.logger?.error('[livething] leaveChannel threw during close', {
        connectionId: connection.id,
        channel: membership.channelName,
        channelFamily: membership.channelFamily,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  removeConnectionFromTagIndex(runtime.tagMembers, connection);

  if (connection.keepaliveTimer !== undefined) {
    clearTimeout(connection.keepaliveTimer as ReturnType<typeof setTimeout>);
    connection.keepaliveTimer = undefined;
  }

  if (connection.deferTimers) {
    for (const timer of connection.deferTimers) clearTimeout(timer);
    connection.deferTimers.clear();
  }

  for (const hook of runtime.connectionCleanupHooks ?? []) {
    try {
      hook(connection.id);
    } catch (error) {
      runtime.logger?.error('[livething] connection cleanup hook threw', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
  const normalizedDescriptor = normalizeConnectionDescriptor(descriptor, {
    onInvalidCloseCode: (code) => {
      runtime.logger?.error('[livething] invalid server close code; closing with internal error', {
        code,
      });
    },
  });

  assertUsableUserId(normalizedDescriptor.userId);

  const translator = createTranslator(runtime, normalizedDescriptor);
  if (translator === null) return closedHandle();

  // A per-user connection cap only applies to identified users — an anonymous
  // connection has no user identity to count against.
  const usersPolicy = runtime.compiled.usersPolicy;
  if (usersPolicy?.maxConnections !== undefined && normalizedDescriptor.userId) {
    const existing = runtime.usersByKey.get(normalizedDescriptor.userId);
    const held = existing?.size ?? 0;
    if (held >= usersPolicy.maxConnections) {
      if (usersPolicy.onExceed === 'reject') {
        normalizedDescriptor.close(CloseCodes.CAPACITY, 'connection limit reached for this user');
        return closedHandle();
      }

      // `replace`: evict the oldest connection(s) — set iteration is insertion
      // order — until admitting the newcomer would sit at the cap. The real
      // close event lands later, so the evicted socket is dropped from the
      // user-key index right away and marked pending: a rapid burst must not
      // still count it toward `held`, or ask it to close a second time.
      let toEvict = held - usersPolicy.maxConnections + 1;
      for (const oldest of existing ?? []) {
        if (toEvict <= 0) break;

        // Removed from the index the moment it's picked, so it can never be
        // picked again by this or a later burst round.
        if (pendingEvictions.has(oldest)) continue;

        pendingEvictions.add(oldest);
        removeConnectionFromUserIndex(runtime.usersByKey, oldest);
        oldest.descriptor.close(CloseCodes.DUPLICATE, 'replaced by a newer connection');
        toEvict -= 1;
      }
    }
  }

  const connection: EngineRuntimeTypes.RuntimeConnection = {
    id: runtime.generateId('conn'),
    userId: normalizedDescriptor.userId,
    wsKey,
    descriptor: translatedDescriptor({
      runtime,
      descriptor: normalizedDescriptor,
      translator,
      getConnection: () => connection,
    }),
    meta: normalizedDescriptor.meta ?? {},
    ...(translator ? { translator } : {}),

    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships: new Map(),

    latency: null,
    quality: 'good',
  };

  for (const ref of normalizedDescriptor.tags ?? []) {
    if (ref.kind !== 'ephemeral') continue;

    addConnectionTag(runtime.tagMembers, connection, {
      kind: 'ephemeral',
      group: ref.group,
      key: ref.key,
    });
  }

  runtime.connections.set(connection.id, connection);
  addConnectionToUserIndex(runtime.usersByKey, connection);
  runtime.wsToConnectionId.set(wsKey, connection.id);
  // Initial write goes through without the gate so the row exists from the
  // moment the connection is live. Then the gate is set so onConnect state
  // changes (channel subscribes, ephemeral tag adds, etc.) batch into one
  // flush after the hook resolves.
  try {
    runtime.persistAttachment(connection);
    if (connection.closing) {
      rollbackConnectionIndexes(runtime, connection);
      runtime.deleteConnectionState?.(connection.id);
      return closedHandle();
    }
  } catch (error) {
    rollbackConnectionIndexes(runtime, connection);
    runtime.deleteConnectionState?.(connection.id);
    throw error;
  }

  connection.pendingWrites = { active: true };

  const ctx = runtime.buildConnectionContext(connection);
  // Auto-rejoin (channel membership and persistent tags) runs before onConnect
  // so handlers see the connection already restored. `engine.deps.ts` wires
  // `autoRejoinIdentity` on every real engine regardless of which capabilities
  // are listed, so a real engine always takes the async branch below — the
  // synchronous branch only fires for a runtime bag that omits the field
  // entirely, which only a test harness does. An unconditional `.then()`
  // chain would shift `onConnect`'s timing by a microtask for those tests.
  const lifecyclePromise = runtime.autoRejoinIdentity
    ? runtime
        .autoRejoinIdentity(connection)
        .catch((error) => {
          // A rejoin failure (e.g. a storage hiccup) must not skip onConnect.
          // Log it and still run the connect lifecycle so the handler fires.
          runtime.logger?.error('[livething] auto-rejoin failed; running onConnect anyway', {
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

function restoreWakeIndexes(input: RestoreWakeIndexesInput): boolean {
  const { runtime, connection, row, restoredStreamIds } = input;
  try {
    runtime.connections.set(connection.id, connection);
    addConnectionToUserIndex(runtime.usersByKey, connection);
    runtime.wsToConnectionId.set(connection.wsKey, connection.id);

    for (const tag of row?.ephemeral_tags ?? []) {
      addConnectionTag(runtime.tagMembers, connection, {
        kind: 'ephemeral',
        group: tag.group,
        key: tag.key,
      });
    }

    for (const membership of row?.ephemeral_memberships ?? []) {
      ChannelPrimitive.addChannelMembership(runtime.channelMembers, connection, {
        channelName: membership.channelName,
        channelFamily: membership.channelFamily,
      });
    }

    runtime.reloadPersistentTags?.(connection);

    for (const streamId of restoredStreamIds) {
      const sent = connection.descriptor.send(
        serializeWireFrame(
          '__error__',
          { code: StreamAborted.code, detail: { reason: 'hibernation-wake' as const } },
          { streamId },
        ),
      );
      if (connection.closing) {
        rollbackConnectionIndexes(runtime, connection);
        runtime.deleteConnectionState?.(connection.id);
        return false;
      }

      if (sent !== false) connection.activeStreamIds?.delete(streamId);
    }

    if (restoredStreamIds.length > 0) {
      (runtime.flushAttachment ?? runtime.persistAttachment)(connection);
      if (connection.closing) {
        rollbackConnectionIndexes(runtime, connection);
        if (!connection.preserveStateOnClose) runtime.deleteConnectionState?.(connection.id);
        return false;
      }
    }

    return true;
  } catch (error) {
    rollbackConnectionIndexes(runtime, connection);
    if (!connection.preserveStateOnClose) runtime.deleteConnectionState?.(connection.id);
    throw error;
  }
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
  let attachment: unknown;
  try {
    attachment = runtime.restoreAttachment
      ? assertSynchronousResult(runtime.restoreAttachment(wsKey), 'adapter hibernation.restore')
      : undefined;
  } catch (error) {
    wsLike.close?.(CloseCodes.INTERNAL_ERROR, '[livething] hibernation restore failed');
    throw error;
  }

  const attachmentId =
    attachment &&
    typeof attachment === 'object' &&
    typeof (attachment as { id?: unknown }).id === 'string'
      ? (attachment as { id: string }).id
      : undefined;

  const row =
    attachmentId && runtime.readConnectionState ? runtime.readConnectionState(attachmentId) : null;

  if (row) {
    try {
      assertUsableUserId(row.user_id);
    } catch {
      runtime.deleteConnectionState?.(row.connection_id);
      wsLike.close?.(CloseCodes.GOING_AWAY, 'invalid persisted user id');
      return closedHandle();
    }
  }

  const id = row?.connection_id ?? attachmentId ?? runtime.generateId('conn');
  const userId = row?.user_id ?? '';
  const meta = row?.meta ?? {};
  if (runtime.connections.has(id)) {
    wsLike.close?.(CloseCodes.INTERNAL_ERROR, '[livething] duplicate hibernation connection id');
    throw new Error(`[livething] hibernation restore found duplicate connection id "${id}".`);
  }

  const ephemeralRefs: PublicApi.TagRef[] = (row?.ephemeral_tags ?? []).map((t) => ({
    __livething: 'tag-ref' as const,
    kind: 'ephemeral' as const,
    group: t.group,
    key: t.key,
  }));
  // Both filled after the connection is created so the add* helpers can also
  // repopulate the engine-wide channel and tag member indexes.
  const channelMemberships = new Map<
    string,
    { channelName: string; channelFamily: string | null }
  >();
  const restoredStreamIds = row?.active_stream_ids ?? [];

  const rawDescriptor = normalizeConnectionDescriptor(
    {
      send: (data) => wsLike.send?.(data),
      close: (code, reason) => wsLike.close?.(code, reason),
      bufferedAmount: () => 0,
      userId,
      meta,
      tags: ephemeralRefs,
    },
    {
      onInvalidCloseCode: (code) => {
        runtime.logger?.error(
          '[livething] invalid server close code; closing with internal error',
          {
            code,
          },
        );
      },
    },
  );
  const translator = createTranslator(runtime, rawDescriptor);
  if (translator === null) {
    if (row) runtime.deleteConnectionState?.(row.connection_id);
    return closedHandle();
  }

  const translatorHibernation = translator?.hibernation;
  if (translatorHibernation) {
    try {
      assertSynchronousResult(
        translatorHibernation.restore(row?.translator_state),
        'translator.hibernation.restore',
      );
    } catch (error) {
      rethrowTranslatorConfigError(error, rawDescriptor);
      closeForTranslationFailure({
        runtime,
        descriptor: rawDescriptor,
        stage: 'restore',
        error,
      });
      if (row) runtime.deleteConnectionState?.(row.connection_id);
      return closedHandle();
    }
  }

  const connection: EngineRuntimeTypes.RuntimeConnection = {
    id,
    userId,
    wsKey,
    descriptor: translatedDescriptor({
      runtime,
      descriptor: rawDescriptor,
      translator,
      getConnection: () => connection,
    }),
    meta,
    ...(translator ? { translator } : {}),
    tags: { ephemeral: new Map(), persistent: new Map() },
    channelMemberships,
    ...(restoredStreamIds.length > 0 ? { activeStreamIds: new Set(restoredStreamIds) } : {}),
    latency: null,
    quality: 'good',
  };

  if (!restoreWakeIndexes({ runtime, connection, row, restoredStreamIds })) return closedHandle();

  connection.lifecycleReady = Promise.resolve();

  return createHandle(runtime, connection);
}

/**
 * Run the optional upgrade hook and normalize its result into adapter-friendly
 * accept/reject data.
 */
export async function handleUpgrade(
  runtime: HandleUpgradeRuntimeParameter,
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
    // identity). At most one hook may own `userId`.
    let mergedMeta: Record<string, unknown> | undefined;
    let resolvedUserId: string | undefined;
    let userIdOwner: string | undefined;
    const mergedTags: PublicApi.TagRef[] = [];
    function apply(result: ApplyResultParameter, owner: string): void {
      if (result.userId !== undefined) {
        if (userIdOwner !== undefined) {
          throw new Error(
            `[livething] Two upgrade hooks returned 'userId' (${userIdOwner} and ${owner}). ` +
              'A user id has exactly one owner per connection — the app or one plugin, never both.',
          );
        }

        userIdOwner = owner;
        resolvedUserId = result.userId;
      }

      if (result.meta) {
        mergedMeta = mergedMeta ? { ...mergedMeta, ...result.meta } : { ...result.meta };
      }

      if (result.tags) {
        for (const ref of result.tags) {
          if (ref.kind === 'persistent') {
            throw new Error(
              `[livething] onUpgrade returned a persistent tag ref for group '${ref.group}'. Persistent tags must be added at runtime via ctx.tags.persistent('${ref.group}').add(...).`,
            );
          }

          if (!runtime.isTagGroupDeclared('ephemeral', ref.group)) {
            throw new Error(
              `[livething] onUpgrade returned an ephemeral tag for group '${ref.group}', which is not declared under tags (ephemeral). Add it to the tags(...) capability or check for a typo.`,
            );
          }

          // Same rules as `add()`: an empty key is a no-op, and a group with a
          // schema must accept the key.
          if (ref.key.length === 0) continue;

          const schema = runtime.getTagGroupSchema('ephemeral', ref.group);
          if (schema) {
            try {
              validateValue(schema, ref.key, `tag ephemeral:${ref.group}`);
            } catch (error) {
              throw new Error(
                `[livething] onUpgrade returned the ephemeral tag key '${ref.key}' for group '${ref.group}', which the group's schema rejects.`,
                { cause: error },
              );
            }
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

    const builderUpgradeHook = runtime.builderUpgradeHook;
    if (builderUpgradeHook) {
      const call: CallDescriptor = { kind: 'upgrade', getCtx: () => runtime.upgradeHelpers.ctx };
      const result = await withCallContext(runtime.asyncContext, call, () =>
        builderUpgradeHook(request, runtime.upgradeHelpers),
      );
      apply(result ?? {}, 'the app');
    }

    return {
      userId: resolvedUserId,
      meta: mergedMeta,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
    };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (error as { __livething?: string }).__livething === 'reject-upgrade'
    ) {
      const code = (error as { code: number }).code;
      if (isValidCloseCode(code) || isValidHttpUpgradeStatus(code)) {
        return {
          reject: true,
          code,
          reason: (error as { reason: string }).reason,
        };
      }

      runtime.logger?.error('[livething] invalid upgrade rejection code; rejecting with HTTP 403', {
        code,
      });
      return {
        reject: true,
        code: 403,
        reason: 'Upgrade rejected',
      };
    }

    // The client only sees a generic reason; the real error goes to the log.
    runtime.logger?.error('[livething] upgrade hook threw; rejecting with HTTP 500', {
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      ...(error instanceof Error && error.cause !== undefined
        ? { cause: error.cause instanceof Error ? error.cause.message : String(error.cause) }
        : {}),
    });
    return {
      reject: true,
      code: 500,
      reason: 'Upgrade failed',
    };
  }
}

function isValidHttpUpgradeStatus(code: unknown): code is number {
  return typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599;
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
    logger?: Pick<PublicApi.Logger, 'error'>;
    asyncContext?: EngineAsyncContext;
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

  // Shutdown is a best-effort drain: a throwing hook must not block stream
  // cancellation or socket close. Each hook runs inside its own try/catch
  // with logging; cleanup below always runs.
  for (const hook of runtime.shutdownHooks) {
    try {
      const ctx = runtime.createShutdownContext();
      await withCallContext(runtime.asyncContext, { kind: 'shutdown', getCtx: () => ctx }, () =>
        hook(ctx),
      );
    } catch (error) {
      runtime.logger?.error('[livething] shutdown hook threw', {
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
      runtime.logger?.error('[livething] plugin shutdown hook threw', {
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
        runtime.logger?.error('[livething] handleConnectionClose threw during shutdown', {
          connectionId: connection.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}
