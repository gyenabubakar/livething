import { AsyncLocalStorage } from 'node:async_hooks';
import { CloseCodes } from '@wskit/core';
import {
  acceptConnection,
  cancelActiveStreamsForConnection,
  handleConnectionClose,
  handleShutdown,
  runConnectionLifecycle,
  wakeHibernatedConnection,
} from '~/_engine/runtime/connection.ts';
import { addConnectionTag } from '~/_engine/runtime/tag-index.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as EngineRuntimeTypes from '~/_engine/runtime/types.ts';

type AsyncContextStore = {
  connectionId?: string;
  [key: PropertyKey]: unknown;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

describe('connection runtime', () => {
  it('limits close reasons before passing them to the adapter', () => {
    const close = vi.fn();
    const runtime = {
      compiled: {
        outgoing: new Map(),
        incoming: new Map(),
        requests: new Map(),
        streams: new Map(),
        resumableStreams: new Map(),
        recordedStreams: new Map(),
        intercepts: [],
        channels: new Map(),
        channelFamilies: new Map(),
        scheduled: new Map(),
        requires: {},
        replayClaimedChannelKeys: new Set(),
      },
      connections: new Map(),
      usersByKey: new Map(),
      wsToConnectionId: new Map(),
      channelMembers: new Map(),
      tagMembers: new Map(),
      generateId() {
        return 'conn_close_reason';
      },
      persistAttachment() {},
      buildConnectionContext() {
        return {};
      },
      async runConnectionLifecycle() {},
      async processTextMessage() {},
      async handleConnectionClose() {},
      async handleRuntimeError() {},
    };

    acceptConnection(runtime as never, Symbol('ws'), {
      send() {},
      close,
      bufferedAmount() {
        return 0;
      },
      userId: 'close-reason-test',
    });

    const connection = [...runtime.connections.values()][0] as EngineRuntimeTypes.RuntimeConnection;
    connection.descriptor.close(CloseCodes.NORMAL, '🙂'.repeat(100));

    expect(close).toHaveBeenCalledWith(CloseCodes.NORMAL, '🙂'.repeat(30));
  });

  it('routes rejected message callbacks through engine error handling', async () => {
    const failure = new Error('message processing failed');
    const handledErrors: unknown[] = [];

    const handle = acceptConnection(
      {
        compiled: {
          outgoing: new Map(),
          incoming: new Map(),
          requests: new Map(),
          streams: new Map(),
          resumableStreams: new Map(),
          recordedStreams: new Map(),
          intercepts: [],
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        connections: new Map(),
        usersByKey: new Map(),
        wsToConnectionId: new Map(),
        channelMembers: new Map(),
        tagMembers: new Map(),
        generateId() {
          return 'conn_error';
        },
        persistAttachment() {},
        buildConnectionContext() {
          return {};
        },
        async runConnectionLifecycle() {},
        async processTextMessage() {
          throw failure;
        },
        async handleConnectionClose() {},
        async handleRuntimeError(_connection: unknown, error: unknown) {
          handledErrors.push(error);
        },
      } as never,
      Symbol('ws'),
      {
        send() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
        userId: 'error-test',
      },
    );

    await expect(handle.handleMessage('hello')).resolves.toBeUndefined();
    expect(handledErrors).toEqual([failure]);
  });

  it('waits for async connect lifecycle work before handling the first message', async () => {
    const events: string[] = [];
    const gate = deferred();

    const handle = acceptConnection(
      {
        compiled: {
          outgoing: new Map(),
          incoming: new Map(),
          requests: new Map(),
          streams: new Map(),
          resumableStreams: new Map(),
          recordedStreams: new Map(),
          intercepts: [],
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        connections: new Map(),
        usersByKey: new Map(),
        wsToConnectionId: new Map(),
        channelMembers: new Map(),
        tagMembers: new Map(),
        generateId() {
          return 'conn_1';
        },
        persistAttachment() {},
        buildConnectionContext(connection) {
          return { id: connection.id };
        },
        async runConnectionLifecycle() {
          events.push('connect:start');
          await gate.promise;
          events.push('connect:end');
        },
        async processTextMessage() {
          events.push('message');
        },
        async handleConnectionClose() {
          events.push('close');
        },
        async handleRuntimeError() {
          events.push('error');
        },
      },
      Symbol('ws'),
      {
        send() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
        userId: 'lifecycle-test',
      },
    );

    const pendingMessage = handle.handleMessage('hello');

    await Promise.resolve();
    expect(events).toEqual(['connect:start']);

    gate.resolve();
    await pendingMessage;

    expect(events).toEqual(['connect:start', 'connect:end', 'message']);
  });

  it('queues every adapter callback received during onConnect and runs them all after the gate resolves', async () => {
    const events: string[] = [];
    const gate = deferred();

    const handle = acceptConnection(
      {
        compiled: {
          outgoing: new Map(),
          incoming: new Map(),
          requests: new Map(),
          streams: new Map(),
          resumableStreams: new Map(),
          recordedStreams: new Map(),
          intercepts: [],
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        connections: new Map(),
        usersByKey: new Map(),
        wsToConnectionId: new Map(),
        channelMembers: new Map(),
        tagMembers: new Map(),
        generateId() {
          return 'conn_2';
        },
        persistAttachment() {},
        buildConnectionContext(connection) {
          return { id: connection.id };
        },
        async runConnectionLifecycle(kind) {
          events.push(`lifecycle:${kind}:start`);
          if (kind === 'connect') await gate.promise;
          events.push(`lifecycle:${kind}:end`);
        },
        async processTextMessage(_conn, data) {
          events.push(`message:${data}`);
        },
        async handleConnectionClose() {
          events.push('close');
        },
        async handleRuntimeError() {
          events.push('error');
        },
      },
      Symbol('ws'),
      {
        send() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
        userId: 'lifecycle-test',
      },
    );

    const a = handle.handleMessage('a');
    const b = handle.handleMessage('b');
    const c = handle.handleMessage('c');
    const closed = handle.handleClose(1000, 'bye');

    await Promise.resolve();
    expect(events).toEqual(['lifecycle:connect:start']);

    gate.resolve();
    await Promise.all([a, b, c, closed]);

    // onConnect must complete before any callback runs. After that, all four
    // queued callbacks run (order between message and close is permitted to
    // interleave but every one must execute exactly once).
    expect(events[0]).toBe('lifecycle:connect:start');
    expect(events[1]).toBe('lifecycle:connect:end');
    const remaining = events.slice(2).sort();
    expect(remaining).toEqual(['close', 'message:a', 'message:b', 'message:c']);
  });

  it('runs onConnect even when handleClose is the first callback the adapter fires', async () => {
    const events: string[] = [];
    const gate = deferred();

    const handle = acceptConnection(
      {
        compiled: {
          outgoing: new Map(),
          incoming: new Map(),
          requests: new Map(),
          streams: new Map(),
          resumableStreams: new Map(),
          recordedStreams: new Map(),
          intercepts: [],
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        connections: new Map(),
        usersByKey: new Map(),
        wsToConnectionId: new Map(),
        channelMembers: new Map(),
        tagMembers: new Map(),
        generateId() {
          return 'conn_3';
        },
        persistAttachment() {},
        buildConnectionContext(connection) {
          return { id: connection.id };
        },
        async runConnectionLifecycle(kind) {
          events.push(`lifecycle:${kind}`);
          if (kind === 'connect') await gate.promise;
        },
        async processTextMessage() {
          events.push('message');
        },
        async handleConnectionClose() {
          events.push('close');
        },
        async handleRuntimeError() {
          events.push('error');
        },
      },
      Symbol('ws'),
      {
        send() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
        userId: 'lifecycle-test',
      },
    );

    const closed = handle.handleClose(1000, 'gone');

    await Promise.resolve();
    expect(events).toEqual(['lifecycle:connect']);

    gate.resolve();
    await closed;

    // onConnect must run even when the very first adapter callback is close.
    // Disconnect handlers run inside handleConnectionClose, which the test
    // mock collapses into a single 'close' event for ordering purposes.
    expect(events).toEqual(['lifecycle:connect', 'close']);
  });

  it('never pings a connection on its own — sending pings belongs to keepalive()', () => {
    vi.useFakeTimers();

    const compiled = {
      outgoing: new Map(),
      incoming: new Map(),
      requests: new Map(),
      streams: new Map(),
      resumableStreams: new Map(),
      recordedStreams: new Map(),
      intercepts: [],
      channels: new Map(),
      channelFamilies: new Map(),
      scheduled: new Map(),
      requires: {},
      replayClaimedChannelKeys: new Set<string>(),
    };

    const sent: string[] = [];
    acceptConnection(
      {
        compiled,
        connections: new Map(),
        usersByKey: new Map(),
        wsToConnectionId: new Map(),
        channelMembers: new Map(),
        tagMembers: new Map(),
        generateId() {
          return 'conn_ping_a';
        },
        persistAttachment() {},
        buildConnectionContext(connection) {
          return { id: connection.id };
        },
        async runConnectionLifecycle() {},
        async processTextMessage() {},
        async handleConnectionClose() {},
        async handleRuntimeError() {},
      },
      Symbol('ws-a'),
      {
        send(data: string) {
          sent.push(data);
        },
        close() {},
        bufferedAmount() {
          return 0;
        },
        userId: 'ping-test',
      },
    );

    // A generous interval — long enough that any ping timer would have fired.
    vi.advanceTimersByTime(120_000);
    expect(sent).not.toContain('ping');

    vi.useRealTimers();
  });

  it('rolls back indexes when the initial hibernation persist fails', () => {
    const connections = new Map();
    const usersByKey = new Map();
    const wsToConnectionId = new Map();
    const channelMembers = new Map();
    const tagMembers = new Map();
    const deleted: string[] = [];
    const failure = new Error('persist failed');
    const wsKey = Symbol('ws');

    expect(() =>
      acceptConnection(
        {
          compiled: {
            outgoing: new Map(),
            incoming: new Map(),
            requests: new Map(),
            streams: new Map(),
            resumableStreams: new Map(),
            recordedStreams: new Map(),
            intercepts: [],
            channels: new Map(),
            channelFamilies: new Map(),
            scheduled: new Map(),
            requires: {},
            replayClaimedChannelKeys: new Set(),
          },
          connections,
          usersByKey,
          wsToConnectionId,
          channelMembers,
          tagMembers,
          generateId: () => 'conn_1',
          persistAttachment() {
            throw failure;
          },
          deleteConnectionState(id) {
            deleted.push(id);
          },
          buildConnectionContext(connection) {
            return { id: connection.id };
          },
          async runConnectionLifecycle() {},
          async processTextMessage() {},
          async handleConnectionClose() {},
          async handleRuntimeError() {},
        },
        wsKey,
        {
          send() {},
          close() {},
          bufferedAmount() {
            return 0;
          },
          userId: 'persist-test',
        },
      ),
    ).toThrow(failure);

    expect(connections.size).toBe(0);
    expect(usersByKey.size).toBe(0);
    expect(wsToConnectionId.size).toBe(0);
    expect(tagMembers.size).toBe(0);
    expect(deleted).toEqual(['conn_1']);
  });

  it('wakeHibernatedConnection sends __error__ for each orphaned stream ID in the attachment', () => {
    const sent: string[] = [];
    const wsKey = {
      send(data: string) {
        sent.push(data);
      },
      close() {},
    };

    wakeHibernatedConnection(
      {
        compiled: {
          outgoing: new Map(),
          incoming: new Map(),
          requests: new Map(),
          streams: new Map(),
          resumableStreams: new Map(),
          recordedStreams: new Map(),
          intercepts: [],
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        connections: new Map(),
        usersByKey: new Map(),
        wsToConnectionId: new Map(),
        channelMembers: new Map(),
        tagMembers: new Map(),
        generateId() {
          return 'conn_1';
        },
        persistAttachment() {},
        restoreAttachment: () => ({ id: 'conn_1' }),
        readConnectionState: () => ({
          connection_id: 'conn_1',
          user_id: 'conn_1',
          meta: {},
          ephemeral_tags: [],
          ephemeral_memberships: [],
          active_stream_ids: ['stream_1', 'stream_2'],
        }),
        buildConnectionContext(connection) {
          return { id: connection.id };
        },
        async runConnectionLifecycle() {},
        async processTextMessage() {},
        async handleConnectionClose() {},
        async handleRuntimeError() {},
      },
      wsKey,
    );

    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0]!)).toEqual({
      event: '__error__',
      payload: {
        code: 'stream-aborted',
        detail: { reason: 'hibernation-wake' },
      },
      __wskit: { streamId: 'stream_1' },
    });
    expect(JSON.parse(sent[1]!)).toEqual({
      event: '__error__',
      payload: {
        code: 'stream-aborted',
        detail: { reason: 'hibernation-wake' },
      },
      __wskit: { streamId: 'stream_2' },
    });
  });

  it('wakeHibernatedConnection sends no __error__ frames when attachment has no active streams', () => {
    const sent: string[] = [];
    const wsKey = {
      send(data: string) {
        sent.push(data);
      },
      close() {},
    };

    wakeHibernatedConnection(
      {
        compiled: {
          outgoing: new Map(),
          incoming: new Map(),
          requests: new Map(),
          streams: new Map(),
          resumableStreams: new Map(),
          recordedStreams: new Map(),
          intercepts: [],
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        connections: new Map(),
        usersByKey: new Map(),
        wsToConnectionId: new Map(),
        channelMembers: new Map(),
        tagMembers: new Map(),
        generateId() {
          return 'conn_1';
        },
        persistAttachment() {},
        restoreAttachment: () => ({ id: 'conn_1', meta: {}, tags: [], channelMemberships: [] }),
        buildConnectionContext(connection) {
          return { id: connection.id };
        },
        async runConnectionLifecycle() {},
        async processTextMessage() {},
        async handleConnectionClose() {},
        async handleRuntimeError() {},
      },
      wsKey,
    );

    expect(sent).toHaveLength(0);
  });

  it('wakeHibernatedConnection reloads persistent tags (snapshot only carries ephemeral)', () => {
    // The hibernation snapshot only stores ephemeral tags. Persistent tags are
    // identity-scoped in durable storage, so the wake path must reload them or
    // the woken socket silently falls out of every persistent tag fan-out.
    const wsKey = {
      send() {},
      close() {},
    };

    const tagMembers = new Map();
    const reloaded: string[] = [];

    wakeHibernatedConnection(
      {
        compiled: {
          outgoing: new Map(),
          incoming: new Map(),
          requests: new Map(),
          streams: new Map(),
          resumableStreams: new Map(),
          recordedStreams: new Map(),
          intercepts: [],
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        connections: new Map(),
        usersByKey: new Map(),
        wsToConnectionId: new Map(),
        channelMembers: new Map(),
        tagMembers,
        generateId() {
          return 'conn_1';
        },
        persistAttachment() {},
        restoreAttachment: () => ({ id: 'conn_1' }),
        readConnectionState: () => ({
          connection_id: 'conn_1',
          user_id: 'user-1',
          meta: {},
          ephemeral_tags: [],
          ephemeral_memberships: [],
          active_stream_ids: [],
        }),
        reloadPersistentTags(connection) {
          reloaded.push(connection.userId);
          tagMembers.set('persistent:role/admin', new Set([connection]));
        },
        buildConnectionContext(connection) {
          return { id: connection.id };
        },
        async runConnectionLifecycle() {},
        async processTextMessage() {},
        async handleConnectionClose() {},
        async handleRuntimeError() {},
      },
      wsKey,
    );

    expect(reloaded).toEqual(['user-1']);
    expect(tagMembers.get('persistent:role/admin')?.size).toBe(1);
  });

  it('rolls back every in-memory index when wake fails after restoring state', () => {
    const wsKey = {
      send() {},
      close() {},
    };
    const connections = new Map();
    const usersByKey = new Map();
    const wsToConnectionId = new Map();
    const channelMembers = new Map();
    const tagMembers = new Map();
    const failure = new Error('persistent tag storage failed');

    expect(() =>
      wakeHibernatedConnection(
        {
          compiled: {
            outgoing: new Map(),
            incoming: new Map(),
            requests: new Map(),
            streams: new Map(),
            resumableStreams: new Map(),
            recordedStreams: new Map(),
            intercepts: [],
            channels: new Map(),
            channelFamilies: new Map(),
            scheduled: new Map(),
            requires: {},
            replayClaimedChannelKeys: new Set(),
          },
          connections,
          usersByKey,
          wsToConnectionId,
          channelMembers,
          tagMembers,
          generateId: () => 'conn_1',
          persistAttachment() {},
          restoreAttachment: () => ({ id: 'conn_1' }),
          readConnectionState: () => ({
            connection_id: 'conn_1',
            user_id: 'user-1',
            meta: {},
            ephemeral_tags: [{ group: 'role', key: 'admin' }],
            ephemeral_memberships: [{ channelName: 'room', channelFamily: null }],
            active_stream_ids: [],
          }),
          reloadPersistentTags(connection) {
            addConnectionTag(tagMembers, connection, {
              kind: 'persistent',
              group: 'tier',
              key: 'pro',
            });
            throw failure;
          },
          buildConnectionContext(connection) {
            return { id: connection.id };
          },
          async runConnectionLifecycle() {},
          async processTextMessage() {},
          async handleConnectionClose() {},
          async handleRuntimeError() {},
        },
        wsKey,
      ),
    ).toThrow(failure);

    expect(connections.size).toBe(0);
    expect(usersByKey.size).toBe(0);
    expect(wsToConnectionId.size).toBe(0);
    expect(channelMembers.size).toBe(0);
    expect(tagMembers.size).toBe(0);
  });

  it.each([
    ['reserved', '__bcast:room'],
    ['oversized', 'u'.repeat(257)],
  ])('rejects a legacy persisted %s user id before restoring the socket', async (_kind, userId) => {
    const wsKey = {
      send: vi.fn(),
      close: vi.fn(),
    };
    const connections = new Map();
    const usersByKey = new Map();
    const channelMembers = new Map();
    const tagMembers = new Map();
    const deleted: string[] = [];

    const handle = wakeHibernatedConnection(
      {
        compiled: {
          outgoing: new Map(),
          incoming: new Map(),
          requests: new Map(),
          streams: new Map(),
          resumableStreams: new Map(),
          recordedStreams: new Map(),
          intercepts: [],
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        connections,
        usersByKey,
        wsToConnectionId: new Map(),
        channelMembers,
        tagMembers,
        generateId: () => 'conn_new',
        persistAttachment() {},
        restoreAttachment: () => ({ id: 'legacy-1' }),
        readConnectionState: () => ({
          connection_id: 'legacy-1',
          user_id: userId,
          meta: {},
          ephemeral_tags: [{ group: 'role', key: 'admin' }],
          ephemeral_memberships: [{ channelName: 'room', channelFamily: null }],
          active_stream_ids: ['stream-1'],
        }),
        deleteConnectionState: (id) => deleted.push(id),
        buildConnectionContext(connection) {
          return { id: connection.id };
        },
        async runConnectionLifecycle() {},
        async processTextMessage() {},
        async handleConnectionClose() {},
        async handleRuntimeError() {},
      },
      wsKey,
    );

    expect(wsKey.close).toHaveBeenCalledWith(
      CloseCodes.GOING_AWAY,
      expect.stringMatching(/user id/i),
    );
    expect(deleted).toEqual(['legacy-1']);
    expect(connections.size).toBe(0);
    expect(usersByKey.size).toBe(0);
    expect(channelMembers.size).toBe(0);
    expect(tagMembers.size).toBe(0);
    expect(wsKey.send).not.toHaveBeenCalled();
    await expect(handle.handleMessage('ignored')).resolves.toBeUndefined();
  });

  it('awaits handleConnectionClose for every connection before resolving', async () => {
    // Pin F4: pre-fix the shutdown loop called descriptor.close and
    // returned without awaiting the per-connection cleanup chain. The
    // CF DO could be evicted before onDisconnect or _memberLeave
    // fanned out. The fix awaits handleConnectionClose for each.
    const order: string[] = [];
    let resolveClose!: () => void;
    const closeWait = new Promise<void>((r) => (resolveClose = r));

    const connections = new Map([
      [
        'conn_slow',
        {
          id: 'conn_slow',
          descriptor: { close() {} },
        },
      ],
    ]) as Map<string, { id: string; descriptor: { close(): void } }>;

    const shutdownPromise = handleShutdown({
      connections: connections as never,
      shutdownHooks: [],
      createShutdownContext: () => ({}),
      async cancelActiveStreamsForConnection() {},
      async handleConnectionClose() {
        order.push('close-start');
        await closeWait;
        order.push('close-end');
      },
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['close-start']);

    resolveClose();
    await shutdownPromise;
    expect(order).toEqual(['close-start', 'close-end']);
  });

  it('runs plugin onShutdown hooks during engine shutdown', async () => {
    const events: string[] = [];
    const closed: Array<{ code: number; reason: string }> = [];
    const connections = new Map([
      [
        'conn_1',
        {
          id: 'conn_1',
          descriptor: {
            close(code: number, reason: string) {
              closed.push({ code, reason });
            },
          },
        },
      ],
    ]) as Map<string, { id: string; descriptor: { close(code: number, reason: string): void } }>;

    await handleShutdown({
      connections: connections as never,
      shutdownHooks: [
        async () => {
          events.push('server-shutdown');
        },
      ],
      pluginShutdownHooks: [
        {
          async handler() {
            events.push('plugin-shutdown');
          },
        },
      ],
      createShutdownContext() {
        return { kind: 'shutdown-context' };
      },
      async cancelActiveStreamsForConnection(connectionId: string) {
        events.push(`cancel:${connectionId}`);
      },
      async handleConnectionClose(connection) {
        events.push(`close:${connection.id}`);
      },
    });

    // handleConnectionClose is awaited per-connection so onDisconnect
    // and channel cleanup land before shutdown returns.
    expect(events).toEqual(['server-shutdown', 'plugin-shutdown', 'close:conn_1']);
    expect(closed).toEqual([{ code: 1001, reason: 'Server shutting down' }]);
  });

  it('continues shutdown cleanup when a server onShutdown hook throws', async () => {
    const closed: Array<{ code: number; reason: string }> = [];
    const cancelled: string[] = [];
    const errorLog: Array<{ message: string; fields?: Record<string, unknown> }> = [];

    const connections = new Map([
      [
        'conn_1',
        {
          id: 'conn_1',
          descriptor: {
            close(code: number, reason: string) {
              closed.push({ code, reason });
            },
          },
        },
      ],
      [
        'conn_2',
        {
          id: 'conn_2',
          descriptor: {
            close(code: number, reason: string) {
              closed.push({ code, reason });
            },
          },
        },
      ],
    ]) as Map<string, { id: string; descriptor: { close(code: number, reason: string): void } }>;

    await handleShutdown({
      connections: connections as never,
      shutdownHooks: [
        async () => {
          throw new Error('boom from onShutdown');
        },
      ],
      pluginShutdownHooks: [
        {
          async handler() {
            throw new Error('boom from plugin onShutdown');
          },
        },
      ],
      createShutdownContext() {
        return { kind: 'shutdown-context' };
      },
      async cancelActiveStreamsForConnection() {},
      async handleConnectionClose(connection) {
        cancelled.push(connection.id);
      },
      logger: {
        error(message: string, fields?: Record<string, unknown>) {
          errorLog.push({ message, fields });
        },
      },
    });

    // Per-connection close and socket close both run despite throws.
    // (Order between conn_1 and conn_2 close-callback invocations is not
    // guaranteed because they run in parallel via Promise.all; check as a set.)
    expect(new Set(cancelled)).toEqual(new Set(['conn_1', 'conn_2']));
    expect(closed).toEqual([
      { code: 1001, reason: 'Server shutting down' },
      { code: 1001, reason: 'Server shutting down' },
    ]);
    expect(errorLog.map((e) => e.message)).toEqual([
      '[wskit] shutdown hook threw',
      '[wskit] plugin shutdown hook threw',
    ]);
  });

  it('runs lifecycle hooks inside the connection async context', async () => {
    const asyncContext = new AsyncLocalStorage<AsyncContextStore>();
    let seen: string | undefined;

    await runConnectionLifecycle(
      {
        connectHooks: [
          () => {
            seen = asyncContext.getStore()?.connectionId;
          },
        ],
        disconnectHooks: [],
        asyncContext,
      },
      'connect',
      { connection: { id: 'conn_42' } },
    );

    expect(seen).toBe('conn_42');
    // The async context is auto-scoped — nothing leaks past the lifecycle.
    expect(asyncContext.getStore()).toBeUndefined();
  });

  it('does not leak the async context when an onConnect hook throws', async () => {
    const asyncContext = new AsyncLocalStorage<AsyncContextStore>();

    await expect(
      runConnectionLifecycle(
        {
          connectHooks: [
            () => {
              throw new Error('boom');
            },
          ],
          disconnectHooks: [],
          asyncContext,
        },
        'connect',
        { connection: { id: 'conn_42' } },
      ),
    ).rejects.toThrow('boom');

    expect(asyncContext.getStore()).toBeUndefined();
  });

  it('handleConnectionClose attaches closeCode and closeReason to the disconnect ctx', async () => {
    // Pin F3: the close metadata from the adapter (webSocketClose passes
    // real code and reason) flows through the engine and lands on the
    // ctx the onDisconnect hook receives. Without this thread, user
    // code cannot tell graceful (1000) from kick (4001) from abnormal
    // (1006).
    let observedCode: unknown;
    let observedReason: unknown;
    const connection: EngineRuntimeTypes.RuntimeConnection = {
      id: 'c1',
      wsKey: Symbol('ws'),
      descriptor: {
        send() {},
        close() {},
        bufferedAmount: () => 0,
        userId: 'c1',
      },
      userId: 'c1',
      meta: {},
      tags: {
        ephemeral: new Map<string, Set<string>>(),
        persistent: new Map<string, Set<string>>(),
      },
      channelMemberships: new Map(),
      latency: null,
      quality: 'good' as const,
    };
    const runtime = {
      compiled: { channels: new Map(), channelFamilies: new Map() } as never,
      connections: new Map([[connection.id, connection]]) as never,
      usersByKey: new Map() as never,
      wsToConnectionId: new Map() as never,
      async cancelActiveStreamsForConnection() {},
      buildConnectionContext: () => ({ id: connection.id }) as Record<PropertyKey, unknown>,
      async runConnectionLifecycle(
        _kind: 'connect' | 'disconnect',
        ctx: Record<PropertyKey, unknown>,
      ) {
        observedCode = ctx.closeCode;
        observedReason = ctx.closeReason;
      },
      async leaveChannel() {},
    };

    await handleConnectionClose(runtime as never, {
      connection: connection as never,
      code: 4001,
      reason: 'kicked-by-admin',
    });

    expect(observedCode).toBe(4001);
    expect(observedReason).toBe('kicked-by-admin');
  });

  it('handleConnectionClose is a no-op on a connection that was already cleaned up', async () => {
    // Idempotency guard: handleShutdown drives close cleanup directly,
    // then the adapter's natural webSocketClose callback may fire a
    // second time for the same socket. Re-running the lifecycle would
    // double-fire onDisconnect and rebroadcast _memberLeave to peers.
    const events: string[] = [];
    const wsKey = Symbol('ws');
    const connection = {
      id: 'c1',
      wsKey,
      descriptor: {
        send() {},
        close() {},
        bufferedAmount: () => 0,
        userId: 'c1',
      },
      userId: 'c1',
      meta: {},
      tags: {
        ephemeral: new Map<string, Set<string>>(),
        persistent: new Map<string, Set<string>>(),
      },
      channelMemberships: new Map(),
      latency: null,
      quality: 'good' as const,
    };
    // Connection is NOT in the connections map — simulating "already
    // cleaned up by an earlier handleConnectionClose call".
    const runtime = {
      compiled: { channels: new Map(), channelFamilies: new Map() } as never,
      connections: new Map() as never,
      usersByKey: new Map() as never,
      wsToConnectionId: new Map() as never,
      async cancelActiveStreamsForConnection() {
        events.push('cancel-streams');
      },
      buildConnectionContext: () => ({ id: connection.id }),
      async runConnectionLifecycle() {
        events.push('disconnect-hook');
      },
      async leaveChannel() {
        events.push('leave-channel');
      },
    };

    await handleConnectionClose(runtime as never, {
      connection: connection as never,
      code: 1000,
      reason: 'normal',
    });

    expect(events).toEqual([]);
  });

  it('handleConnectionClose continues channel-leave fan-out when a disconnect hook throws', async () => {
    // Pre-fix a throwing onDisconnect aborted the close sequence —
    // channel members never received `_memberLeave`, the keepalive
    // timer leaked. handleConnectionClose now contains the throw and
    // proceeds with the remaining cleanup.
    const events: string[] = [];
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const wsKey = Symbol('ws');
    const connection = {
      id: 'c1',
      userId: 'c1',
      wsKey,
      descriptor: {
        send() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
        userId: 'c1',
      },
      meta: {},
      tags: {
        ephemeral: new Map<string, Set<string>>(),
        persistent: new Map<string, Set<string>>(),
      },
      channelMemberships: new Map([['::room', { channelName: 'room' }]]),
      latency: null,
      quality: 'good' as const,
    };
    const runtime = {
      compiled: {
        channels: new Map(),
        channelFamilies: new Map(),
      } as never,
      connections: new Map([[connection.id, connection]]) as never,
      usersByKey: new Map() as never,
      wsToConnectionId: new Map([[wsKey, connection.id]]) as never,
      logger,
      async cancelActiveStreamsForConnection() {
        events.push('streams-cancelled');
      },
      buildConnectionContext: () => ({ id: connection.id }),
      async runConnectionLifecycle() {
        events.push('disconnect-hook:start');
        throw new Error('disconnect hook threw');
      },
      async leaveChannel() {
        events.push('channel-left');
      },
    };

    await expect(
      handleConnectionClose(runtime as never, {
        connection: connection as never,
        code: 1000,
        reason: 'normal',
      }),
    ).resolves.toBeUndefined();

    expect(events).toEqual(['streams-cancelled', 'disconnect-hook:start', 'channel-left']);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatch(/disconnect lifecycle hook threw/);
  });

  it('handleConnectionClose continues to subsequent channels and keepalive cleanup when one leaveChannel throws', async () => {
    // Pre-fix a throwing leaveChannel (e.g. an onUnsubscribe hook that
    // rejects) aborted the for-loop. Subsequent channel leaves and the
    // keepalive timer cleanup never ran. The close path now contains
    // the throw per membership and proceeds.
    const events: string[] = [];
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const wsKey = Symbol('ws');
    const keepaliveHandle = Symbol('keepalive');
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const connection = {
      id: 'c1',
      userId: 'c1',
      wsKey,
      descriptor: {
        send() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
        userId: 'c1',
      },
      meta: {},
      tags: {
        ephemeral: new Map<string, Set<string>>(),
        persistent: new Map<string, Set<string>>(),
      },
      channelMemberships: new Map([
        ['::one', { channelName: 'one' }],
        ['::two', { channelName: 'two' }],
      ]),
      latency: null,
      quality: 'good' as const,
      keepaliveTimer: keepaliveHandle as unknown as number,
    };
    const runtime = {
      compiled: {
        channels: new Map(),
        channelFamilies: new Map(),
      } as never,
      connections: new Map([[connection.id, connection]]) as never,
      usersByKey: new Map() as never,
      wsToConnectionId: new Map([[wsKey, connection.id]]) as never,
      logger,
      async cancelActiveStreamsForConnection() {
        events.push('streams-cancelled');
      },
      buildConnectionContext: () => ({ id: connection.id }),
      async runConnectionLifecycle() {
        events.push('disconnect-hook');
      },
      async leaveChannel(_conn: unknown, scope: { channelName: string }) {
        events.push(`leave:${scope.channelName}`);
        if (scope.channelName === 'one') throw new Error('hook boom');
      },
    };

    await expect(
      handleConnectionClose(runtime as never, {
        connection: connection as never,
        code: 1000,
        reason: 'normal',
      }),
    ).resolves.toBeUndefined();

    expect(events).toEqual(['streams-cancelled', 'disconnect-hook', 'leave:one', 'leave:two']);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(keepaliveHandle);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatch(/leaveChannel threw during close/);
    clearTimeoutSpy.mockRestore();
  });

  it('marks the connection as closing before channel-leave cleanup runs', async () => {
    const wsKey = Symbol('ws');
    const connection = {
      id: 'c1',
      userId: 'c1',
      wsKey,
      descriptor: {
        send() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
        userId: 'c1',
      },
      meta: {},
      tags: {
        ephemeral: new Map<string, Set<string>>(),
        persistent: new Map<string, Set<string>>(),
      },
      channelMemberships: new Map([['::room', { channelName: 'room', channelFamily: null }]]),
      latency: null,
      quality: 'good' as const,
    };
    const observed: boolean[] = [];
    const runtime = {
      compiled: {
        channels: new Map(),
        channelFamilies: new Map(),
      } as never,
      connections: new Map([[connection.id, connection]]) as never,
      usersByKey: new Map() as never,
      wsToConnectionId: new Map([[wsKey, connection.id]]) as never,
      deleteConnectionState() {},
      async cancelActiveStreamsForConnection() {},
      buildConnectionContext: () => ({ id: connection.id }),
      async runConnectionLifecycle() {},
      async leaveChannel(conn: EngineRuntimeTypes.RuntimeConnection) {
        observed.push(Boolean(conn.closing));
      },
    };

    await handleConnectionClose(runtime as never, {
      connection: connection as never,
      code: 1000,
      reason: 'normal',
    });

    expect(observed).toEqual([true]);
  });

  it('cancelActiveStreamsForConnection logs and continues when one stream cleanup throws', async () => {
    // A user-supplied generator can throw from its `finally` block when
    // generator.return() runs. Pre-fix that throw escaped the helper and
    // aborted the rest of handleConnectionClose (delete connection, run
    // disconnect hooks, leave channels, clear timers). Now the helper
    // catches the throw, logs it, and keeps cleaning up subsequent streams.
    const throwing = (async function* () {
      try {
        yield 1;
      } finally {
        // oxlint-disable-next-line no-unsafe-finally
        throw new Error('user finally threw');
      }
    })();
    await throwing.next();

    const clean = (async function* () {
      yield 'ok';
    })();
    await clean.next();

    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const runtime = {
      activeStreams: new Map<string, never>([
        [
          'stream_throwing',
          {
            id: 'stream_throwing',
            connectionId: 'c1',
            generator: throwing,
            closed: false,
          } as never,
        ],
        [
          'stream_clean',
          {
            id: 'stream_clean',
            connectionId: 'c1',
            generator: clean,
            closed: false,
          } as never,
        ],
      ]),
      logger,
    };

    await expect(cancelActiveStreamsForConnection(runtime, 'c1')).resolves.toBeUndefined();

    expect(runtime.activeStreams.size).toBe(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, fields] = logger.error.mock.calls[0]!;
    expect(message).toMatch(/stream cleanup threw/);
    expect((fields as { streamId?: string }).streamId).toBe('stream_throwing');
  });
});
