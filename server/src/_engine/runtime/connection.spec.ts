import {
  acceptConnection,
  handleShutdown,
  wakeHibernatedConnection,
} from '~/_engine/runtime/connection.ts';
import { describe, expect, it } from 'vitest';

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
      serializeAttachment() {},
      deserializeAttachment() {
        return {
          id: 'conn_1',
          meta: {},
          tags: [],
          channelMemberships: [],
          activeStreamIds: ['stream_1', 'stream_2'],
        };
      },
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
      payload: { code: 'internal-error', _streamId: 'stream_1' },
    });
    expect(JSON.parse(sent[1]!)).toEqual({
      event: '_error',
      payload: { code: 'internal-error', _streamId: 'stream_2' },
    });
  });

  it('wakeHibernatedConnection sends no _error frames when attachment has no active streams', () => {
    const sent: string[] = [];
    const wsKey = {
      send(data: string) {
        sent.push(data);
      },
      close() {},
      serializeAttachment() {},
      deserializeAttachment() {
        return { id: 'conn_1', meta: {}, tags: [], channelMemberships: [] };
      },
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
      alarmState: { current: 'alarm-handle' },
    });

    expect(events).toEqual(['server-shutdown', 'module-shutdown', 'cancel:conn_1']);
    expect(closed).toEqual([{ code: 1001, reason: 'Server shutting down' }]);
    expect(cleared).toEqual(['alarm-handle']);
  });
});
