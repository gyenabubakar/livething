import {
  acceptConnection,
  cancelActiveStreamsForConnection,
  handleBinaryMessage,
  handleConnectionClose,
  handleShutdown,
  runConnectionLifecycle,
  wakeHibernatedConnection,
} from '~/_engine/runtime/connection.ts';
import { describe, expect, it, vi } from 'vitest';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

describe('connection runtime', () => {
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
          preIntercepts: [],
          postIntercepts: new Map(),
          namespaces: new Map(),
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          modules: [],
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        timers: undefined,
        connections: new Map(),
        wsToConnectionId: new Map(),
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
        async handleBinaryMessage() {
          events.push('binary');
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
        sendBinary() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
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
          preIntercepts: [],
          postIntercepts: new Map(),
          namespaces: new Map(),
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          modules: [],
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        timers: undefined,
        connections: new Map(),
        wsToConnectionId: new Map(),
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
        async handleBinaryMessage() {
          events.push('binary');
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
        sendBinary() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
      },
    );

    // Fire three messages and a close while connect is still running.
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
          preIntercepts: [],
          postIntercepts: new Map(),
          namespaces: new Map(),
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          modules: [],
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        timers: undefined,
        connections: new Map(),
        wsToConnectionId: new Map(),
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
        async handleBinaryMessage() {
          events.push('binary');
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
        sendBinary() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
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

  it('wakeHibernatedConnection sends _error for each orphaned stream ID in the attachment', () => {
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
          preIntercepts: [],
          postIntercepts: new Map(),
          namespaces: new Map(),
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          modules: [],
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        timers: undefined,
        connections: new Map(),
        wsToConnectionId: new Map(),
        generateId() {
          return 'conn_1';
        },
        persistAttachment() {},
        restoreAttachment: () => ({
          id: 'conn_1',
          meta: {},
          tags: [],
          channelMemberships: [],
          activeStreamIds: ['stream_1', 'stream_2'],
        }),
        buildConnectionContext(connection) {
          return { id: connection.id };
        },
        async runConnectionLifecycle() {},
        async processTextMessage() {},
        async handleBinaryMessage() {},
        async handleConnectionClose() {},
        async handleRuntimeError() {},
      },
      wsKey,
    );

    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0]!)).toEqual({
      event: '_error',
      payload: { code: 'stream-aborted', _streamId: 'stream_1' },
    });
    expect(JSON.parse(sent[1]!)).toEqual({
      event: '_error',
      payload: { code: 'stream-aborted', _streamId: 'stream_2' },
    });
  });

  it('wakeHibernatedConnection sends no _error frames when attachment has no active streams', () => {
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
          preIntercepts: [],
          postIntercepts: new Map(),
          namespaces: new Map(),
          channels: new Map(),
          channelFamilies: new Map(),
          scheduled: new Map(),
          modules: [],
          requires: {},
          replayClaimedChannelKeys: new Set(),
        },
        timers: undefined,
        connections: new Map(),
        wsToConnectionId: new Map(),
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
        async handleBinaryMessage() {},
        async handleConnectionClose() {},
        async handleRuntimeError() {},
      },
      wsKey,
    );

    expect(sent).toHaveLength(0);
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
      timers: { setTimeout: () => Symbol(), clearTimeout: () => undefined },
      shutdownHooks: [],
      moduleRuntimes: [],
      createShutdownContext: () => ({}),
      async cancelActiveStreamsForConnection() {},
      async handleConnectionClose() {
        order.push('close-start');
        await closeWait;
        order.push('close-end');
      },
      alarmState: { current: null },
    });

    // Give the microtasks a chance to enter handleConnectionClose.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['close-start']);

    // Resolve close cleanup; shutdown should now finish.
    resolveClose();
    await shutdownPromise;
    expect(order).toEqual(['close-start', 'close-end']);
  });

  it('runs module onShutdown hooks during engine shutdown', async () => {
    const events: string[] = [];
    const closed: Array<{ code: number; reason: string }> = [];
    const cleared: unknown[] = [];
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
      timers: {
        setTimeout() {
          return Symbol('timeout');
        },
        clearTimeout(handle: unknown) {
          cleared.push(handle);
        },
      },
      shutdownHooks: [
        async () => {
          events.push('server-shutdown');
        },
      ],
      moduleRuntimes: [
        {
          async onShutdown() {
            events.push('module-shutdown');
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
      alarmState: { current: 'alarm-handle' },
    });

    // handleConnectionClose is awaited per-connection so onDisconnect
    // and channel cleanup land before shutdown returns.
    expect(events).toEqual(['server-shutdown', 'module-shutdown', 'close:conn_1']);
    expect(closed).toEqual([{ code: 1001, reason: 'Server shutting down' }]);
    expect(cleared).toEqual(['alarm-handle']);
  });

  it('continues shutdown cleanup when a server onShutdown hook throws', async () => {
    const closed: Array<{ code: number; reason: string }> = [];
    const cancelled: string[] = [];
    const cleared: unknown[] = [];
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
      timers: {
        setTimeout() {
          return Symbol('timeout');
        },
        clearTimeout(handle: unknown) {
          cleared.push(handle);
        },
      },
      shutdownHooks: [
        async () => {
          throw new Error('boom from onShutdown');
        },
      ],
      moduleRuntimes: [
        {
          async onShutdown() {
            throw new Error('boom from module onShutdown');
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
      alarmState: { current: 'alarm-handle' },
      logger: {
        error(message: string, fields?: Record<string, unknown>) {
          errorLog.push({ message, fields });
        },
      },
    });

    // Per-connection close, socket close, and alarm clear all run despite throws.
    // (Order between conn_1 and conn_2 close-callback invocations is not
    // guaranteed because they run in parallel via Promise.all; check as a set.)
    expect(new Set(cancelled)).toEqual(new Set(['conn_1', 'conn_2']));
    expect(closed).toEqual([
      { code: 1001, reason: 'Server shutting down' },
      { code: 1001, reason: 'Server shutting down' },
    ]);
    expect(cleared).toEqual(['alarm-handle']);
    // Both throws were logged.
    expect(errorLog.map((e) => e.message)).toEqual([
      '[wskit] shutdown hook threw',
      '[wskit] module shutdown hook threw',
    ]);
  });

  it('restores activeConnectionState.current when an onConnect hook throws', async () => {
    const activeConnectionState: { current?: string } = { current: 'previous-conn' };

    await expect(
      runConnectionLifecycle(
        {
          connectHooks: [
            () => {
              throw new Error('boom');
            },
          ],
          disconnectHooks: [],
          moduleRuntimes: [],
          activeConnectionState,
          createModuleScopedContext(_id, ctx) {
            return ctx;
          },
        },
        'connect',
        { id: 'conn_42' },
      ),
    ).rejects.toThrow('boom');

    expect(activeConnectionState.current).toBe('previous-conn');
  });

  it('restores activeConnectionState.current to undefined when no previous value existed', async () => {
    const activeConnectionState: { current?: string } = {};

    await runConnectionLifecycle(
      {
        connectHooks: [() => {}],
        disconnectHooks: [],
        moduleRuntimes: [],
        activeConnectionState,
        createModuleScopedContext(_id, ctx) {
          return ctx;
        },
      },
      'connect',
      { id: 'conn_99' },
    );

    expect(activeConnectionState.current).toBeUndefined();
  });

  it('handleConnectionClose attaches closeCode and closeReason to the disconnect ctx', async () => {
    // Pin F3: the close metadata from the adapter (webSocketClose passes
    // real code and reason) flows through the engine and lands on the
    // ctx the onDisconnect hook receives. Without this thread, user
    // code cannot tell graceful (1000) from kick (4001) from abnormal
    // (1006).
    let observedCode: unknown;
    let observedReason: unknown;
    const connection = {
      id: 'c1',
      wsKey: Symbol('ws'),
      descriptor: { send() {}, sendBinary() {}, close() {}, bufferedAmount: () => 0 },
      meta: {},
      tags: new Set<string>(),
      channelMemberships: new Map(),
      latency: null,
      quality: 'good' as const,
    };
    const runtime = {
      compiled: { channels: new Map(), channelFamilies: new Map() } as never,
      connections: new Map([[connection.id, connection]]) as never,
      wsToConnectionId: new Map() as never,
      timers: undefined,
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

    await handleConnectionClose(runtime as never, connection as never, 4001, 'kicked-by-admin');

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
      descriptor: { send() {}, sendBinary() {}, close() {}, bufferedAmount: () => 0 },
      meta: {},
      tags: new Set<string>(),
      channelMemberships: new Map(),
      latency: null,
      quality: 'good' as const,
    };
    // Connection is NOT in the connections map — simulating "already
    // cleaned up by an earlier handleConnectionClose call".
    const runtime = {
      compiled: { channels: new Map(), channelFamilies: new Map() } as never,
      connections: new Map() as never,
      wsToConnectionId: new Map() as never,
      timers: undefined,
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

    await handleConnectionClose(runtime as never, connection as never, 1000, 'normal');

    // Nothing ran — guard short-circuited at the top.
    expect(events).toEqual([]);
  });

  it('handleConnectionClose continues channel-leave fan-out when a disconnect hook throws', async () => {
    // Pre-fix a throwing onDisconnect aborted the close sequence —
    // channel members never received `_memberLeave`, the heartbeat
    // timer leaked. handleConnectionClose now contains the throw and
    // proceeds with the remaining cleanup.
    const events: string[] = [];
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const wsKey = Symbol('ws');
    const connection = {
      id: 'c1',
      wsKey,
      descriptor: {
        send() {},
        sendBinary() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
      },
      meta: {},
      tags: new Set<string>(),
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
      wsToConnectionId: new Map([[wsKey, connection.id]]) as never,
      timers: undefined,
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
      handleConnectionClose(runtime as never, connection as never, 1000, 'normal'),
    ).resolves.toBeUndefined();

    // Channel-leave still ran despite the hook throwing.
    expect(events).toEqual(['streams-cancelled', 'disconnect-hook:start', 'channel-left']);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatch(/disconnect lifecycle hook threw/);
  });

  it('handleConnectionClose continues to subsequent channels and heartbeat cleanup when one leaveChannel throws', async () => {
    // Pre-fix a throwing leaveChannel (e.g. an onUnsubscribe hook that
    // rejects) aborted the for-loop. Subsequent channel leaves and the
    // heartbeat timer cleanup never ran. The close path now contains
    // the throw per membership and proceeds.
    const events: string[] = [];
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const wsKey = Symbol('ws');
    const heartbeatHandle = Symbol('heartbeat');
    const clearTimeout = vi.fn();
    const connection = {
      id: 'c1',
      wsKey,
      descriptor: {
        send() {},
        sendBinary() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
      },
      meta: {},
      tags: new Set<string>(),
      channelMemberships: new Map([
        ['::one', { channelName: 'one' }],
        ['::two', { channelName: 'two' }],
      ]),
      latency: null,
      quality: 'good' as const,
      heartbeatTimer: heartbeatHandle as unknown as number,
    };
    const runtime = {
      compiled: {
        channels: new Map(),
        channelFamilies: new Map(),
      } as never,
      connections: new Map([[connection.id, connection]]) as never,
      wsToConnectionId: new Map([[wsKey, connection.id]]) as never,
      timers: { setTimeout: () => 0, clearTimeout } as never,
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
      handleConnectionClose(runtime as never, connection as never, 1000, 'normal'),
    ).resolves.toBeUndefined();

    // Both channels were attempted, heartbeat cleared, and the throw was logged.
    expect(events).toEqual(['streams-cancelled', 'disconnect-hook', 'leave:one', 'leave:two']);
    expect(clearTimeout).toHaveBeenCalledWith(heartbeatHandle);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatch(/leaveChannel threw during close/);
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
    await throwing.next(); // prime past the yield

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

    // Both streams removed despite the first one throwing.
    expect(runtime.activeStreams.size).toBe(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, fields] = logger.error.mock.calls[0]!;
    expect(message).toMatch(/stream cleanup threw/);
    expect((fields as { streamId?: string }).streamId).toBe('stream_throwing');
  });

  describe('handleBinaryMessage', () => {
    function makeConnection(id = 'conn_1') {
      return {
        id,
        wsKey: Symbol(id),
        descriptor: {
          send: vi.fn(),
          sendBinary: vi.fn(),
          close: vi.fn(),
          bufferedAmount() {
            return 0;
          },
        },
        meta: {},
        tags: new Set<string>(),
        channelMemberships: new Map(),
        latency: null,
        quality: 'good' as const,
      };
    }

    it('routes a thrown hook error through handleRuntimeError instead of escaping', async () => {
      const handleRuntimeError = vi.fn(async () => {});
      const buildConnectionContext = vi.fn(() => ({ id: 'conn_1' }));
      const failingHook = vi.fn(async () => {
        throw new Error('bad protobuf bytes');
      });
      const followUpHook = vi.fn();

      const connection = makeConnection();

      await expect(
        handleBinaryMessage(
          {
            buildConnectionContext,
            handleRuntimeError,
            activityHooks: [],
            binaryHooks: [failingHook, followUpHook],
          } as never,
          connection as never,
          new ArrayBuffer(4),
        ),
      ).resolves.toBeUndefined();

      expect(handleRuntimeError).toHaveBeenCalledTimes(1);
      const call = handleRuntimeError.mock.calls[0] as unknown as [unknown, unknown];
      const routedConnection = call[0] as { id: string };
      const routedError = call[1] as Error;
      expect(routedConnection.id).toBe('conn_1');
      expect(routedError.message).toBe('bad protobuf bytes');
      // First throw stops the loop — later hooks do not run for this frame.
      expect(followUpHook).not.toHaveBeenCalled();
    });

    it('does not call handleRuntimeError when every hook succeeds', async () => {
      const handleRuntimeError = vi.fn(async () => {});
      const hook = vi.fn(async () => {});
      const connection = makeConnection();

      await handleBinaryMessage(
        {
          buildConnectionContext: () => ({ id: 'conn_1' }),
          handleRuntimeError,
          activityHooks: [],
          binaryHooks: [hook],
        } as never,
        connection as never,
        new ArrayBuffer(2),
      );

      expect(hook).toHaveBeenCalledTimes(1);
      expect(handleRuntimeError).not.toHaveBeenCalled();
    });
  });
});
