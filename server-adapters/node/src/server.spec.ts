import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ServerAdapters from '@wskit/server/adapters';
import type { Server } from 'node:http';
import type { NodeWebSocketServer } from './upgrade.ts';

type FakeEngine = {
  initialize: ReturnType<typeof vi.fn>;
  reconcileConnections: ReturnType<typeof vi.fn>;
  handleAlarm: ReturnType<typeof vi.fn>;
  handleShutdown: ReturnType<typeof vi.fn>;
  handleUpgrade: ReturnType<typeof vi.fn>;
  accept: ReturnType<typeof vi.fn>;
  admin: ReturnType<typeof vi.fn>;
};

type AdapterConfig = {
  hibernation?: unknown;
  setup(createEngine: (options: unknown) => FakeEngine, options: unknown): unknown;
};

let config: AdapterConfig;
let fake: FakeEngine;
let createOptions: unknown[];

vi.mock('@wskit/server/adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerAdapters>()),
  adapter: (adapterConfig: AdapterConfig) => {
    config = adapterConfig;
    return (_handler: unknown, options: unknown) =>
      adapterConfig.setup((runtimeOptions) => {
        createOptions.push(runtimeOptions);
        return fake;
      }, options);
  },
}));

const { server } = await import('./server.ts');

class FakeHttpServer extends EventEmitter {
  listening = false;

  listen = vi.fn((_options: unknown, callback: () => void) => {
    this.listening = true;
    callback();
    return this;
  });

  close = vi.fn((callback: (error?: Error) => void) => {
    this.listening = false;
    callback();
    return this;
  });
}

function incomingRequest(): IncomingMessage {
  return Object.assign(new IncomingMessage(new Socket()), {
    url: '/socket',
    method: 'GET',
    headers: {
      host: 'example.test',
      connection: 'Upgrade',
      upgrade: 'websocket',
    },
  });
}

function upgradeSocket() {
  return {
    once: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
  } as never;
}

function fakeWebSocketServer(): NodeWebSocketServer {
  const webSocket = {
    bufferedAmount: 0,
    close: vi.fn(),
    on: vi.fn(),
    send: vi.fn(),
  };
  return {
    handleUpgrade: vi.fn((...args: Parameters<NodeWebSocketServer['handleUpgrade']>) => {
      args[3](webSocket as never, incomingRequest());
    }),
  };
}

function makeEngine(): FakeEngine {
  const admin = { connectionCount: 0 };
  return {
    initialize: vi.fn(async () => {}),
    reconcileConnections: vi.fn(),
    handleAlarm: vi.fn(async () => {}),
    handleShutdown: vi.fn(async () => {}),
    handleUpgrade: vi.fn(async () => ({ userId: 'user-1' })),
    accept: vi.fn(() => ({
      handleMessage: vi.fn(async () => {}),
      handleClose: vi.fn(async () => {}),
      handleError: vi.fn(async () => {}),
    })),
    admin: vi.fn(() => admin),
  };
}

beforeEach(() => {
  fake = makeEngine();
  createOptions = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('server()', () => {
  it('builds through the Node adapter without hibernation and reconciles before ready', async () => {
    const httpServer = new FakeHttpServer();
    const service = server({} as never, { server: httpServer as unknown as Server, env: {} });

    await service.ready;

    expect(config.hibernation).toBeUndefined();
    expect(fake.initialize).toHaveBeenCalledOnce();
    expect(fake.reconcileConnections).toHaveBeenCalledWith(new Set());
    expect(fake.initialize.mock.invocationCallOrder[0]).toBeLessThan(
      fake.reconcileConnections.mock.invocationCallOrder[0]!,
    );
    expect(createOptions[0]).toMatchObject({
      env: {},
      storage: expect.any(Object),
      timers: expect.any(Object),
      waitUntil: expect.any(Function),
    });

    await service.shutdown();
  });

  it('does not accept upgrades until initialization finishes', async () => {
    const httpServer = new FakeHttpServer();
    const webSocketServer = fakeWebSocketServer();
    let finishInitialization!: () => void;
    fake.initialize.mockImplementation(
      () => new Promise<void>((resolve) => (finishInitialization = resolve)),
    );
    const service = server({} as never, {
      server: httpServer as unknown as Server,
      webSocketServer,
    });

    httpServer.emit('upgrade', incomingRequest(), upgradeSocket(), Buffer.alloc(0));
    await Promise.resolve();
    expect(fake.handleUpgrade).not.toHaveBeenCalled();

    finishInitialization();
    await service.ready;
    await vi.waitFor(() => expect(fake.handleUpgrade).toHaveBeenCalledOnce());

    await service.shutdown();
  });

  it('forwards alarms, shutdown, and admin calls', async () => {
    vi.useFakeTimers();
    const httpServer = new FakeHttpServer();
    const service = server({} as never, { server: httpServer as unknown as Server });
    await service.ready;

    const runtime = createOptions[0] as { timers: { setAlarm(time: number): Promise<void> } };
    await runtime.timers.setAlarm(Date.now());
    await vi.runOnlyPendingTimersAsync();
    expect(fake.handleAlarm).toHaveBeenCalledOnce();
    const admin = service.admin();
    expect(fake.admin).toHaveBeenCalledOnce();
    expect(admin).toBe(fake.admin.mock.results[0]?.value);

    await service.shutdown();
    expect(fake.handleShutdown).toHaveBeenCalledOnce();
  });

  it('reports a hibernation configuration failure through ready and shutdown', async () => {
    const failure = new Error('hibernation is not supported by the node adapter');
    fake.initialize.mockRejectedValue(failure);
    const httpServer = new FakeHttpServer();
    const service = server({} as never, { server: httpServer as unknown as Server });

    await expect(service.ready).rejects.toBe(failure);
    await expect(service.shutdown()).rejects.toBe(failure);
    expect(fake.reconcileConnections).not.toHaveBeenCalled();
  });

  it('leaves an injected HTTP server open during shutdown', async () => {
    const httpServer = new FakeHttpServer();
    const service = server({} as never, { server: httpServer as unknown as Server });

    await service.ready;
    await service.shutdown();

    expect(httpServer.close).not.toHaveBeenCalled();
  });

  it('shuts down on SIGTERM when signal handling is enabled', async () => {
    const httpServer = new FakeHttpServer();
    const service = server({} as never, {
      server: httpServer as unknown as Server,
      shutdownOnSignal: true,
    });

    await service.ready;
    process.emit('SIGTERM');

    await vi.waitFor(() => expect(fake.handleShutdown).toHaveBeenCalledOnce());
    await service.shutdown();
  });

  it('does not install signal handlers when signal shutdown is disabled', async () => {
    const before = process.listeners('SIGTERM');
    const httpServer = new FakeHttpServer();
    const service = server({} as never, {
      server: httpServer as unknown as Server,
      shutdownOnSignal: false,
    });

    await service.ready;

    expect(process.listeners('SIGTERM')).toEqual(before);
    await service.shutdown();
  });
});
