import { acceptConnection, handleShutdown } from '~/_engine/runtime/connection.ts';
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
