import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ServerAdapters from '@livething/server/adapters';
import type { NodeEndpointOptions } from './endpoint.ts';

type FakeEngine = {
  initialize: ReturnType<typeof vi.fn>;
  reconcileConnections: ReturnType<typeof vi.fn>;
  handleAlarm: ReturnType<typeof vi.fn>;
  handleShutdown: ReturnType<typeof vi.fn>;
  authenticate: ReturnType<typeof vi.fn>;
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

vi.mock('@livething/server/adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerAdapters>()),
  adapter: (adapterConfig: AdapterConfig) => {
    config = adapterConfig;
    return (_definition: unknown, options: unknown) =>
      adapterConfig.setup((runtimeOptions) => {
        createOptions.push(runtimeOptions);
        return fake;
      }, options);
  },
}));

const { createNodeEndpoint } = await import('./endpoint.ts');
const { binding } = await import('./binding.ts');

function createTestEndpoint(definition: never, options: NodeEndpointOptions) {
  return createNodeEndpoint(definition, options);
}

function incomingRequest(origin?: string): IncomingMessage {
  return Object.assign(new IncomingMessage(new Socket()), {
    url: '/socket',
    method: 'GET',
    headers: {
      host: 'example.test',
      connection: 'Upgrade',
      upgrade: 'websocket',
      ...(origin ? { origin } : {}),
    },
  });
}

function makeEngine(): FakeEngine {
  const admin = { connectionCount: 0 };
  return {
    initialize: vi.fn(async () => {}),
    reconcileConnections: vi.fn(),
    handleAlarm: vi.fn(async () => {}),
    handleShutdown: vi.fn(async () => {}),
    authenticate: vi.fn(async () => ({ userId: 'user-1' })),
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

describe('createNodeEndpoint()', () => {
  it('builds through the Node adapter without hibernation and reconciles before ready', async () => {
    const service = createTestEndpoint({} as never, {});

    await service.ready;

    expect(config.hibernation).toBeUndefined();
    expect(fake.initialize).toHaveBeenCalledOnce();
    expect(fake.reconcileConnections).toHaveBeenCalledWith(new Set());
    expect(fake.initialize.mock.invocationCallOrder[0]).toBeLessThan(
      fake.reconcileConnections.mock.invocationCallOrder[0]!,
    );
    expect(createOptions[0]).toMatchObject({
      storage: expect.any(Object),
      timers: expect.any(Object),
    });

    await service.shutdown();
  });

  it('does not prepare upgrades until initialization finishes', async () => {
    let finishInitialization!: () => void;
    fake.initialize.mockImplementation(
      () => new Promise<void>((resolve) => (finishInitialization = resolve)),
    );
    const service = createTestEndpoint({} as never, {});

    const prepared = service.decideNodeUpgrade(incomingRequest());
    await Promise.resolve();
    expect(fake.authenticate).not.toHaveBeenCalled();

    finishInitialization();
    await service.ready;
    await vi.waitFor(() => expect(fake.authenticate).toHaveBeenCalledOnce());
    await prepared;

    await service.shutdown();
  });

  describe('Origin check', () => {
    it('accepts a Node request from the same origin', async () => {
      const service = createTestEndpoint({} as never, {});

      await expect(
        service.decideNodeUpgrade(incomingRequest('http://example.test')),
      ).resolves.toEqual({ userId: 'user-1' });
      await service.shutdown();
    });

    it('answers 403 to another origin without running authenticate', async () => {
      const service = createTestEndpoint({} as never, {});

      await expect(
        service.decideNodeUpgrade(incomingRequest('https://evil.test')),
      ).resolves.toEqual({
        reject: true,
        code: 403,
        reason: 'Origin not allowed',
      });
      await expect(
        service.decideWebUpgrade(
          new Request('https://example.test/socket', { headers: { origin: 'https://evil.test' } }),
        ),
      ).resolves.toMatchObject({ reject: true, code: 403 });
      expect(fake.authenticate).not.toHaveBeenCalled();
      await service.shutdown();
    });

    it('accepts a request with no Origin header', async () => {
      const service = createTestEndpoint({} as never, {});

      await expect(service.decideNodeUpgrade(incomingRequest())).resolves.toEqual({
        userId: 'user-1',
      });
      await service.shutdown();
    });

    it('accepts an origin listed in allowedOrigins', async () => {
      const service = createTestEndpoint({} as never, {
        allowedOrigins: ['http://localhost:5173'],
      });

      await expect(
        service.decideNodeUpgrade(incomingRequest('http://localhost:5173')),
      ).resolves.toEqual({ userId: 'user-1' });
      await expect(
        service.decideWebUpgrade(
          new Request('https://example.test/socket', {
            headers: { origin: 'http://localhost:5173' },
          }),
        ),
      ).resolves.toEqual({ userId: 'user-1' });
      await service.shutdown();
    });

    it('throws at setup for an allowedOrigins entry that is not an origin', () => {
      expect(() => createTestEndpoint({} as never, { allowedOrigins: ['localhost:5173'] })).toThrow(
        /allowedOrigins/,
      );
    });
  });

  it('throws at setup for a transports list with nothing in it', () => {
    expect(() => createTestEndpoint({} as never, { transports: [] })).toThrow(
      /at least one transport/,
    );
  });

  it('waits for initialization before exposing the admin surface', async () => {
    let finishInitialization!: () => void;
    fake.initialize.mockImplementation(
      () => new Promise<void>((resolve) => (finishInitialization = resolve)),
    );
    const service = createTestEndpoint({} as never, {});

    try {
      const admin = service.admin();

      expect(admin).toBeInstanceOf(Promise);
      expect(fake.admin).not.toHaveBeenCalled();
    } finally {
      finishInitialization();
      await service.ready;
      await service.shutdown();
    }
  });

  it('forwards alarms, shutdown, and admin calls', async () => {
    vi.useFakeTimers();
    const service = createTestEndpoint({} as never, {});
    await service.ready;

    const runtime = createOptions[0] as { timers: { setAlarm(time: number): Promise<void> } };
    await runtime.timers.setAlarm(Date.now());
    await vi.runOnlyPendingTimersAsync();
    expect(fake.handleAlarm).toHaveBeenCalledOnce();
    const admin = await service.admin();

    expect(fake.admin).toHaveBeenCalledOnce();
    expect(admin).toBe(fake.admin.mock.results[0]?.value);

    await service.shutdown();
    expect(fake.handleShutdown).toHaveBeenCalledOnce();
    expect(fake.handleShutdown).toHaveBeenCalledWith({ terminal: true });
  });

  it('waits for an active alarm before running engine shutdown hooks', async () => {
    vi.useFakeTimers();
    let releaseAlarm: (() => void) | undefined;
    const alarmRunning = new Promise<void>((resolve) => {
      releaseAlarm = resolve;
    });
    fake.handleAlarm.mockImplementation(() => alarmRunning);

    const service = createTestEndpoint({} as never, {});

    try {
      await service.ready;
      const runtime = createOptions[0] as { timers: { setAlarm(time: number): Promise<void> } };
      await runtime.timers.setAlarm(Date.now());
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.handleAlarm).toHaveBeenCalledOnce();

      const shutdown = service.shutdown();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fake.handleShutdown).not.toHaveBeenCalled();

      releaseAlarm?.();
      await shutdown;
      expect(fake.handleShutdown).toHaveBeenCalledOnce();
    } finally {
      releaseAlarm?.();
      await service.shutdown();
    }
  });

  it('reports a hibernation configuration failure through ready and shutdown', async () => {
    const failure = new Error('hibernation is not supported by the node adapter');
    fake.initialize.mockRejectedValue(failure);
    const service = createTestEndpoint({} as never, {});

    await expect(service.ready).rejects.toBe(failure);
    await expect(service.shutdown()).rejects.toBe(failure);
    expect(fake.reconcileConnections).not.toHaveBeenCalled();
  });
});

describe('binding()', () => {
  it('prepares an accepted transport and forwards its lifecycle to the engine', async () => {
    const node = binding();
    const endpoint = node.bind({} as never, {});
    const transport = {
      send: vi.fn(),
      close: vi.fn(),
      bufferedAmount: vi.fn(() => 0),
      backpressureSupported: true,
    };

    await endpoint.ready();
    const upgrade = await endpoint.prepareNode(incomingRequest());

    expect(upgrade.type).toBe('accept');
    if (upgrade.type !== 'accept') throw new Error('Expected an accepted upgrade');

    const connection = upgrade.accept(transport);
    await connection.message('hello');
    await connection.close(1000, 'done');

    await connection.error(new Error('failed'));

    expect(fake.accept).toHaveBeenCalledWith(
      transport,
      expect.objectContaining({ userId: 'user-1' }),
    );
    const handle = fake.accept.mock.results[0]?.value;
    expect(handle.handleMessage).toHaveBeenCalledWith('hello');
    expect(handle.handleClose).toHaveBeenCalledWith(1000, 'done');
    expect(handle.handleError).toHaveBeenCalledWith(expect.any(Error));

    await expect(node.shutdown()).resolves.toBeUndefined();
  });

  it('turns engine rejections into host-ready results and replaces spoofed client IP headers', async () => {
    const node = binding();
    const endpoint = node.bind({} as never, {});
    await endpoint.ready();

    fake.authenticate.mockResolvedValueOnce({ reject: true, code: 401, reason: 'No token' });
    const http = await endpoint.prepare(
      new Request('https://example.test/socket', { headers: { 'LiveThing-Client-IP': 'spoofed' } }),
      { clientIp: '203.0.113.7' },
    );
    expect(http.type).toBe('http');
    if (http.type === 'http') {
      expect(http.response.status).toBe(401);
      await expect(http.response.text()).resolves.toBe('No token');
    }

    const request = fake.authenticate.mock.calls[0]?.[0] as Request;

    expect(request.headers.get('LiveThing-Client-IP')).toBe('203.0.113.7');

    fake.authenticate.mockResolvedValueOnce({ reject: true, code: 4001, reason: 'No token' });
    await expect(endpoint.prepareNode(incomingRequest())).resolves.toEqual({
      type: 'socket',
      code: 4001,
      reason: 'No token',
    });
    await expect(node.shutdown()).resolves.toBeUndefined();
  });
});
