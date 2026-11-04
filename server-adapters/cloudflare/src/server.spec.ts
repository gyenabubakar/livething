import { CloseCodes } from '@livething/server/errors';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ServerAdapters from '@livething/server/adapters';
import {
  FakeDurableObjectBase,
  installPermissiveResponse,
  installWebSocketPair,
  makeFakeDOState,
  makeFakeEngine,
} from './test-utils.ts';
import type { CloudflareAdmin } from './admin.ts';
import type { FakeEngine } from './test-utils.ts';

const responseRestore = installPermissiveResponse();
afterAll(() => responseRestore.restore());

const { RpcTargetFake } = vi.hoisted(() => ({ RpcTargetFake: class {} }));

vi.mock('cloudflare:workers', () => ({
  DurableObject: FakeDurableObjectBase,
  RpcTarget: RpcTargetFake,
}));

type AdapterSetup = (
  createEngine: (runtimeOptions: unknown) => unknown,
  options: unknown,
) => unknown;

let fake: FakeEngine;

vi.mock('@livething/server/adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerAdapters>()),
  adapter:
    <TOpts, TSvc>(config: { id: string; hibernation: unknown; setup: AdapterSetup }) =>
    (_handler: unknown, options: TOpts): TSvc => {
      return config.setup((runtimeOptions: unknown) => {
        fake.calls.create.push(runtimeOptions);
        return fake.engine;
      }, options) as TSvc;
    },
}));

// Import AFTER mocks are in place.
const { bind } = await import('./server.ts');

type DOInstance = {
  fetch(req: Request): Promise<Response>;
  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer | ArrayBufferView): Promise<void>;
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean?: boolean): Promise<void>;
  webSocketError(ws: WebSocket, err: unknown): Promise<void>;
  alarm(): Promise<void>;
  shutdown(): Promise<void>;
  admin(): Promise<AdminSurface>;
};

/** The real built-in surface, plus whatever dev api methods a test stages on it. */
type AdminSurface = CloudflareAdmin & Record<string, unknown>;

function buildClass(opts?: { hibernation?: boolean }) {
  fake = makeFakeEngine();
  if (opts?.hibernation !== false) fake.setHibernation(true);
  return bind({} as never) as unknown as new (ctx: DurableObjectState, env: unknown) => DOInstance;
}

function upgradeRequest() {
  return new Request('https://do.example/', {
    headers: { Upgrade: 'websocket' },
  });
}

describe('LiveThingDurableObject fetch / upgrade', () => {
  let pairs: ReturnType<typeof installWebSocketPair>['pairs'];

  beforeEach(() => {
    pairs = installWebSocketPair().pairs;
  });

  it('returns 426 when Upgrade header is missing', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    const res = await instance.fetch(new Request('https://do.example/'));
    expect(res.status).toBe(426);
    expect(fake.calls.handleUpgrade).toHaveLength(0);
  });

  it('passes Cloudflare client IP metadata to the engine request', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    await instance.fetch(
      new Request('https://do.example/', {
        headers: {
          Upgrade: 'websocket',
          'CF-Connecting-IP': '203.0.113.7',
          'LiveThing-Client-IP': '198.51.100.99',
        },
      }),
    );

    expect(fake.calls.handleUpgrade[0]?.headers.get('LiveThing-Client-IP')).toBe('203.0.113.7');
  });

  it('does not pass through a client-supplied IP metadata header', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    await instance.fetch(
      new Request('https://do.example/', {
        headers: {
          Upgrade: 'websocket',
          'LiveThing-Client-IP': '198.51.100.99',
        },
      }),
    );

    expect(fake.calls.handleUpgrade[0]?.headers.get('LiveThing-Client-IP')).toBeNull();
  });

  it('upgrades and returns 101 with client socket when accepted (standard mode)', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    function ref(kind: 'ephemeral', group: string, key: string) {
      return { __livething: 'tag-ref' as const, kind, group, key };
    }

    fake.stageUpgrade({ meta: { user: 'a' }, tags: [ref('ephemeral', 'role', 't1')] });

    const instance = new Cls(state as unknown as DurableObjectState, {});
    const res = await instance.fetch(upgradeRequest());

    expect(res.status).toBe(101);

    const [client, server] = pairs[0]!;
    expect((res as unknown as { webSocket: unknown }).webSocket).toBe(client);
    expect(server.accept).toHaveBeenCalledTimes(1);
    expect(state.acceptWebSocket).not.toHaveBeenCalled();

    expect(fake.calls.accept).toHaveLength(1);
    const desc = fake.calls.accept[0]!.descriptor as {
      meta: Record<string, unknown>;
      tags: readonly { kind: string; group: string; key: string }[];
    };
    expect(desc.meta).toEqual({ user: 'a' });
    expect(desc.tags).toEqual([
      { __livething: 'tag-ref', kind: 'ephemeral', group: 'role', key: 't1' },
    ]);
    expect(fake.calls.create).toHaveLength(1);

    expect(fake.calls.create[0]).toMatchObject({
      logger: expect.any(Object),
      platform: expect.any(Object),
      storage: expect.any(Object),
      timers: expect.any(Object),
      // Cloudflare's own 32 MiB limit, in both directions.
      messageLimits: { receiveBytes: 33_554_432, sendBytes: 33_554_432 },
    });
  });

  it('returns false for a send to a closed socket', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    fake.stageUpgrade({});

    const instance = new Cls(state as unknown as DurableObjectState, {});
    await instance.fetch(upgradeRequest());

    const [, server] = pairs[0]!;
    // workerd throws on send() once the socket has closed.
    server.readyState = 3;
    server.send.mockImplementation(() => {
      throw new Error("Can't call WebSocket send() after close().");
    });
    const desc = fake.calls.accept[0]!.descriptor as { send(data: string): unknown };

    expect(desc.send('frame')).toBe(false);
    expect(server.send).not.toHaveBeenCalled();
  });

  it('closes an accepted socket when engine connection setup throws', async () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    fake.stageUpgrade({});
    const setupError = new Error('connection setup failed');
    (fake.engine.accept as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw setupError;
    });

    const instance = new Cls(state as unknown as DurableObjectState, {});

    await expect(instance.fetch(upgradeRequest())).rejects.toThrow(setupError);

    const [, server] = pairs[0]!;
    expect(state.acceptWebSocket).toHaveBeenCalledWith(server);
    expect(server.close).toHaveBeenCalledWith(1011, '[livething] connection setup failed');
  });

  it('does not close an accepted socket again when the engine already closed it', async () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    fake.stageUpgrade({});
    const setupError = new Error('connection state could not be persisted');
    (fake.engine.accept as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_ws: unknown, descriptor: { close(code: number, reason: string): void }) => {
        descriptor.close(1011, '[livething] connection state could not be persisted');
        throw setupError;
      },
    );

    const instance = new Cls(state as unknown as DurableObjectState, {});

    await expect(instance.fetch(upgradeRequest())).rejects.toThrow(setupError);

    const [, server] = pairs[0]!;
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledWith(
      1011,
      '[livething] connection state could not be persisted',
    );
  });

  it('wires addEventListener handlers that forward to the connection handle (standard mode)', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    fake.stageUpgrade({});

    const instance = new Cls(state as unknown as DurableObjectState, {});
    await instance.fetch(upgradeRequest());

    const [, server] = pairs[0]!;
    server.dispatch('message', { data: 'hi' });
    expect(fake.connectionHandle.handleMessage).toHaveBeenCalledWith('hi');

    server.dispatch('close', { code: 1000, reason: 'bye' });
    expect(fake.connectionHandle.handleClose).toHaveBeenCalledWith(1000, 'bye');

    server.dispatch('error', new Error('boom'));
    expect(fake.connectionHandle.handleError).toHaveBeenCalled();
  });

  it('closes the connection on a binary frame in standard mode instead of silently dropping it', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    fake.stageUpgrade({});

    const instance = new Cls(state as unknown as DurableObjectState, {});
    await instance.fetch(upgradeRequest());

    const [, server] = pairs[0]!;
    server.dispatch('message', { data: new ArrayBuffer(4) });

    expect(server.close).toHaveBeenCalledWith(1003, expect.stringContaining('binary'));
    expect(fake.connectionHandle.handleMessage).not.toHaveBeenCalled();
  });

  it('runs connection cleanup when the standard-mode binary close fires its close event', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    fake.stageUpgrade({});

    const instance = new Cls(state as unknown as DurableObjectState, {});
    await instance.fetch(upgradeRequest());

    const [, server] = pairs[0]!;
    // The runtime fires a 'close' event on a server-initiated close; the fake's
    // close() is a bare spy, so wire it to fire that event the way the runtime does.
    server.close.mockImplementation((code: number, reason: string) =>
      server.dispatch('close', { code, reason }),
    );

    server.dispatch('message', { data: new ArrayBuffer(4) });

    expect(fake.connectionHandle.handleClose).toHaveBeenCalledWith(
      1003,
      expect.stringContaining('binary'),
    );
  });

  it('calls state.acceptWebSocket(ws) without forwarding handler tags into the cf tag store', async () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    fake.stageUpgrade({
      tags: [
        {
          __livething: 'tag-ref' as const,
          kind: 'ephemeral' as const,
          group: 'room',
          key: 'lobby',
        },
        { __livething: 'tag-ref' as const, kind: 'ephemeral' as const, group: 'tier', key: 'free' },
      ],
    });

    const instance = new Cls(state as unknown as DurableObjectState, {});
    const res = await instance.fetch(upgradeRequest());

    expect(res.status).toBe(101);
    const [, server] = pairs[0]!;
    expect(state.acceptWebSocket).toHaveBeenCalledTimes(1);
    expect(state.acceptWebSocket.mock.calls[0]![0]).toBe(server);
    expect(state.acceptWebSocket.mock.calls[0]!).toHaveLength(1);

    expect(server.accept).not.toHaveBeenCalled();
    expect(server.addEventListener).not.toHaveBeenCalled();
  });

  it('registers a ping/pong auto-response under hibernation so keepalives do not wake the DO', async () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    fake.stageUpgrade({});

    const instance = new Cls(state as unknown as DurableObjectState, {});
    await instance.fetch(upgradeRequest());

    expect(state.setWebSocketAutoResponse).toHaveBeenCalledTimes(1);
    const pair = state.setWebSocketAutoResponse.mock.calls[0]![0] as {
      request: string;
      response: string;
    };
    expect(pair.request).toBe('ping');
    expect(pair.response).toBe('pong');
  });

  it('does not register an auto-response in standard (non-hibernation) mode', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    fake.stageUpgrade({});

    const instance = new Cls(state as unknown as DurableObjectState, {});
    await instance.fetch(upgradeRequest());

    expect(state.setWebSocketAutoResponse).not.toHaveBeenCalled();
  });
});

describe('handleRejectedUpgrade', () => {
  let pairs: ReturnType<typeof installWebSocketPair>['pairs'];

  beforeEach(() => {
    pairs = installWebSocketPair().pairs;
  });

  it('returns a 101 response that immediately closes with a WS close code (code >= 1000)', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    fake.stageUpgrade({ reject: true, code: 4002, reason: 'bad' });

    const instance = new Cls(state as unknown as DurableObjectState, {});
    const res = await instance.fetch(upgradeRequest());

    expect(res.status).toBe(101);
    expect(pairs).toHaveLength(1);

    const [client, server] = pairs[0]!;
    expect((res as unknown as { webSocket: unknown }).webSocket).toBe(client);
    expect(server.accept).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledWith(4002, 'bad');
    expect(fake.calls.accept).toHaveLength(0);
  });

  it('limits an oversized WebSocket close reason before closing the pair', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    fake.stageUpgrade({ reject: true, code: 4002, reason: '🙂'.repeat(100) });

    const instance = new Cls(state as unknown as DurableObjectState, {});
    await instance.fetch(upgradeRequest());

    const server = pairs[0]![1];
    expect(server.close).toHaveBeenCalledWith(4002, '🙂'.repeat(30));
  });

  it('returns an HTTP response of the given status when 400 <= code <= 599', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    fake.stageUpgrade({ reject: true, code: 401, reason: 'nope' });

    const instance = new Cls(state as unknown as DurableObjectState, {});
    const res = await instance.fetch(upgradeRequest());

    expect(res.status).toBe(401);
    expect(await res.text()).toBe('nope');
  });

  it('defaults to HTTP 403 when reject code is outside WS (>=1000) and HTTP (400-599) ranges', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    fake.stageUpgrade({ reject: true, code: 42 });

    const instance = new Cls(state as unknown as DurableObjectState, {});
    const res = await instance.fetch(upgradeRequest());

    expect(res.status).toBe(403);
  });

  it('defaults to HTTP 403 when no code is provided on reject', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    fake.stageUpgrade({ reject: true, reason: 'Upgrade rejected' });

    const instance = new Cls(state as unknown as DurableObjectState, {});
    const res = await instance.fetch(upgradeRequest());

    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Upgrade rejected');
  });
});

describe('hibernation wake callbacks', () => {
  beforeEach(() => {
    installWebSocketPair();
  });

  it('webSocketMessage wakes via handleHibernationWake and forwards text', async () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    const ws = { tag: 'hibernated' } as unknown as WebSocket;
    await instance.webSocketMessage(ws, 'hello');

    expect(fake.calls.handleHibernationWake).toEqual([ws]);
    expect(fake.connectionHandle.handleMessage).toHaveBeenCalledWith('hello');
  });

  it.each([
    ['ArrayBuffer', new ArrayBuffer(4)],
    ['ArrayBufferView', new Uint8Array(4)],
  ])('webSocketMessage closes with 1003 on a binary %s frame', async (_kind, frame) => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    const ws = { close: vi.fn() } as unknown as WebSocket;
    await expect(instance.webSocketMessage(ws, frame)).resolves.toBeUndefined();

    expect(ws.close).toHaveBeenCalledWith(
      CloseCodes.UNSUPPORTED_DATA,
      '[livething] binary frames are not supported yet',
    );
    expect(fake.connectionHandle.handleMessage).not.toHaveBeenCalled();
  });

  it('webSocketClose invokes connection.handleClose with code and reason', async () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    const ws = { close: vi.fn() } as unknown as WebSocket;
    await instance.webSocketClose(ws, 1001, 'going away', true);
    expect(ws.close).toHaveBeenCalledWith(1001, 'going away');
    expect(fake.connectionHandle.handleClose).toHaveBeenCalledWith(1001, 'going away');
  });

  it.each([1005, 1006])('webSocketClose answers a %i close with no code', async (code) => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    const ws = { close: vi.fn() } as unknown as WebSocket;
    await instance.webSocketClose(ws, code, '', false);
    expect(ws.close).toHaveBeenCalledWith();
    expect(fake.connectionHandle.handleClose).toHaveBeenCalledWith(code, '');
  });

  it('webSocketError forwards the error without crashing', async () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    const err = new Error('ws-fail');
    await expect(instance.webSocketError({} as WebSocket, err)).resolves.toBeUndefined();
    expect(fake.connectionHandle.handleError).toHaveBeenCalledWith(err);
    expect(fake.connectionHandle.handleClose).toHaveBeenCalledWith(1006, 'socket error');
  });
});

describe('alarm() and shutdown() RPCs', () => {
  beforeEach(() => {
    installWebSocketPair();
  });

  it('alarm() waits for ready and invokes engine.handleAlarm', async () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    await instance.alarm();
    expect(fake.calls.handleAlarm).toBe(1);
    expect(fake.calls.initialize).toBeGreaterThanOrEqual(1);
  });

  it('shutdown() invokes engine.handleShutdown', async () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    await instance.shutdown();
    expect(fake.calls.handleShutdown).toBe(1);
    expect(fake.calls.handleShutdownOptions).toEqual([[]]);
  });

  it('shutdown() under hibernation wakes every Cloudflare-managed socket before draining', async () => {
    const Cls = buildClass({ hibernation: true });
    // deserializeAttachment is stubbed so the boot-time reconcile loop runs
    // cleanly; this test cares about the shutdown wake path, not reconcile.
    const sockA = { __id: 'a', deserializeAttachment: () => null } as unknown;
    const sockB = { __id: 'b', deserializeAttachment: () => null } as unknown;
    const state = makeFakeDOState({
      getWebSockets: vi.fn(() => [sockA, sockB]),
    });
    const instance = new Cls(state as unknown as DurableObjectState, {});

    await instance.shutdown();
    expect(fake.calls.handleHibernationWake).toEqual([sockA, sockB]);
    expect(fake.calls.handleShutdown).toBe(1);
  });

  it('shutdown() without hibernation does not call getWebSockets', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    await instance.shutdown();
    expect(state.getWebSockets).not.toHaveBeenCalled();
    expect(fake.calls.handleHibernationWake).toEqual([]);
    expect(fake.calls.handleShutdown).toBe(1);
  });
});

describe('engine wiring in the constructor', () => {
  beforeEach(() => {
    installWebSocketPair();
  });

  it('provides storage, platform, and timers to the engine', () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    const env = { KEY: 'value' };
    new Cls(state as unknown as DurableObjectState, env);

    expect(fake.calls.create).toHaveLength(1);
    const engineOptions = fake.calls.create[0] as Record<string, unknown>;
    expect(fake.engine.setInstanceId).toHaveBeenCalledWith('fake-instance');
    expect(engineOptions.storage).toBeDefined();
    expect(engineOptions.platform).toMatchObject({ env });

    expect(engineOptions.timers).toBeDefined();
    expect(engineOptions.logger).toBeDefined();

    const adapterLogger = engineOptions.logger as Record<string, unknown>;
    expect(typeof adapterLogger.info).toBe('function');
    expect(typeof adapterLogger.warn).toBe('function');
    expect(typeof adapterLogger.error).toBe('function');
  });

  it('restores every surviving socket at boot under hibernation so live delivery reaches them', async () => {
    const Cls = buildClass({ hibernation: true });
    const sockA = { tag: 'a' } as unknown;
    const sockB = { tag: 'b' } as unknown;
    const state = makeFakeDOState({ getWebSockets: vi.fn(() => [sockA, sockB]) });

    const instance = new Cls(state as unknown as DurableObjectState, {});
    await (instance as unknown as { ready: Promise<void> }).ready;

    expect(fake.calls.restoreHibernatedConnections).toHaveLength(1);
    expect(fake.calls.restoreHibernatedConnections[0]).toEqual([sockA, sockB]);
    // The eager restore supersedes the id-collecting reconcile at boot.
    expect(fake.calls.reconcileConnections).toHaveLength(0);
  });

  it('blocks every lifecycle entrypoint when hibernation restore fails', async () => {
    const failure = new Error('restore failed');
    const Cls = buildClass({ hibernation: true });
    fake.setRestoreFailure(failure);
    const sockA = { tag: 'a' } as unknown;
    const sockB = { tag: 'b' } as unknown;

    const state = makeFakeDOState({ getWebSockets: vi.fn(() => [sockA, sockB]) });
    const instance = new Cls(state as unknown as DurableObjectState, {});
    const ready = (instance as unknown as { ready: Promise<void> }).ready;

    const bootError = await ready.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(bootError).toBe(failure);
    expect(fake.calls.restoreHibernatedConnections).toEqual([[sockA, sockB]]);
    expect(state.setWebSocketAutoResponse).not.toHaveBeenCalled();

    const calls = [
      instance.fetch(upgradeRequest()),
      instance.webSocketMessage({} as WebSocket, 'hello'),
      instance.webSocketClose({ close: vi.fn() } as unknown as WebSocket, 1000, 'bye'),
      instance.webSocketError({} as WebSocket, failure),
      instance.alarm(),
      instance.shutdown(),
      instance.admin(),
    ];
    for (const call of calls) {
      await expect(call).rejects.toBe(failure);
    }

    expect(fake.calls.handleUpgrade).toHaveLength(0);
    expect(fake.calls.handleHibernationWake).toHaveLength(0);
    expect(fake.calls.handleAlarm).toBe(0);
    expect(fake.calls.handleShutdown).toBe(0);

    // Vitest reports an unhandled rejection if the boot restore promise is
    // dropped; yielding here lets that check run before the test completes.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it('observes a boot failure even when no lifecycle event arrives to await ready', async () => {
    const failure = new Error('restore failed before the first event');
    const Cls = buildClass({ hibernation: true });
    fake.setRestoreFailure(failure);

    const unhandled: unknown[] = [];
    function onUnhandled(reason: unknown) {
      unhandled.push(reason);
    }

    const processLike = (
      globalThis as unknown as {
        process: {
          on(event: string, handler: (reason: unknown) => void): void;
          off(event: string, handler: (reason: unknown) => void): void;
        };
      }
    ).process;
    processLike.on('unhandledRejection', onUnhandled);
    try {
      new Cls(makeFakeDOState() as unknown as DurableObjectState, {});
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      processLike.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it('does not restore or reconcile against surviving sockets in standard mode', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState({ getWebSockets: vi.fn(() => [{ tag: 'a' }]) });

    const instance = new Cls(state as unknown as DurableObjectState, {});
    await (instance as unknown as { ready: Promise<void> }).ready;

    expect(fake.calls.restoreHibernatedConnections).toHaveLength(0);
    expect(state.getWebSockets).not.toHaveBeenCalled();
  });
});

describe('LiveThingDurableObject admin()', () => {
  async function adminOf(opts?: { hibernation?: boolean }) {
    const Cls = buildClass(opts);
    const state = makeFakeDOState({ getWebSockets: vi.fn(() => [{ tag: 'ws1' }]) });
    const instance = new Cls(state as unknown as DurableObjectState, {});
    return { admin: await instance.admin(), state };
  }

  it('built-in methods delegate to engine.admin()', async () => {
    const { admin } = await adminOf();
    admin.broadcast('evt', { n: 1 });
    await admin.purgeUser('u1');
    admin.closeConnections({ userId: 'u1' }, 4000, 'gone');

    expect(fake.engine.admin).toHaveBeenCalledTimes(1);
    expect(fake.adminApi.broadcast).toHaveBeenCalledWith('evt', { n: 1 });
    expect(fake.adminApi.purgeUser).toHaveBeenCalledWith('u1', undefined);
    expect(fake.adminApi.closeConnections).toHaveBeenCalledWith({ userId: 'u1' }, 4000, 'gone');
  });

  it('forwards purgeUser options across the stub boundary', async () => {
    const { admin } = await adminOf();
    await admin.purgeUser('u1', { keepBroadcastContent: true });

    expect(fake.adminApi.purgeUser).toHaveBeenCalledWith('u1', { keepBroadcastContent: true });
  });

  it('reaches connections, users, and channels through nested RPC targets, like Node', async () => {
    const { admin } = await adminOf();
    const channels = fake.adminApi.channels as { get: ReturnType<typeof vi.fn> };

    expect(admin.connectionCount).toBe(3);

    const [info] = admin.connections.all();
    expect(info).toMatchObject({ id: 'c1', userId: 'u1' });
    const connection = admin.connections.get(info!.ref());
    expect(connection.send('evt', { n: 1 })).toBe(true);
    expect(fake.adminSpies.connection.send).toHaveBeenCalledWith('evt', { n: 1 });
    // A ref with no instance id is local to this Durable Object.
    expect(
      (fake.adminApi.connections as { get: ReturnType<typeof vi.fn> }).get,
    ).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', instance: 'fake-instance' }));
    connection.close(4000, 'bye');
    expect(fake.adminSpies.connection.close).toHaveBeenCalledWith(4000, 'bye');

    const user = admin.users.get('u1');
    expect(user.id).toBe('u1');
    expect(user.broadcast('evt', { n: 2 })).toBe(2);
    expect(fake.adminSpies.user.broadcast).toHaveBeenCalledWith('evt', { n: 2 });
    (user.setMeta as (patch: Record<string, unknown>) => void)({ displayName: 'Ada' });

    expect(fake.adminSpies.user.setMeta).toHaveBeenCalledWith({ displayName: 'Ada' });
    user.close(4000, 'bye');
    expect(fake.adminSpies.user.close).toHaveBeenCalledWith(4000, 'bye');
    expect(user.isOnline()).toBe(true);

    admin.channels.get('rooms', 'rooms:42').members();
    expect(channels.get).toHaveBeenCalledWith('rooms', 'rooms:42');
    expect(fake.adminSpies.channel.members).toHaveBeenCalled();
  });

  it('channels.broadcast passes the channel, event and payload to the context', async () => {
    const { admin } = await adminOf();
    const broadcast = (fake.adminApi.channels as { broadcast: ReturnType<typeof vi.fn> }).broadcast;

    const channels = admin.channels as unknown as {
      broadcast(channel: unknown, event: string, payload: unknown): unknown;
    };
    expect(channels.broadcast('lobby', 'evt', { n: 3 })).toBeUndefined();
    channels.broadcast({ family: 'rooms', name: 'rooms:42' }, 'evt', { n: 4 });

    expect(broadcast).toHaveBeenNthCalledWith(1, 'lobby', 'evt', { n: 3 });
    expect(broadcast).toHaveBeenNthCalledWith(2, { family: 'rooms', name: 'rooms:42' }, 'evt', {
      n: 4,
    });
    expect('broadcast' in admin.channels.get('lobby')).toBe(false);
  });

  it('every nested part is an RpcTarget reached through a prototype getter or method', async () => {
    const { admin } = await adminOf();

    for (const part of ['connections', 'users', 'channels', 'connectionCount']) {
      expect(Object.hasOwn(admin, part)).toBe(false);
    }

    for (const target of [
      admin.connections,
      admin.users,
      admin.channels,
      admin.users.get('u1'),
      admin.channels.get('lobby'),
      admin.connections.get(admin.connections.all()[0]!.ref()),
    ]) {
      expect(target).toBeInstanceOf(RpcTargetFake);
    }
  });

  it('channels.get does not throw for an unknown channel; the later call does', async () => {
    const { admin } = await adminOf();
    const channels = fake.adminApi.channels as { get: ReturnType<typeof vi.fn> };
    channels.get.mockImplementation(() => {
      throw new Error('channel-not-found');
    });

    const channel = admin.channels.get('nope' as never);

    expect(() => channel.members()).toThrow('channel-not-found');
    expect(() => channel.kick({ __livething: 'tag-ref' } as never, { reason: 'x' })).toThrow(
      'channel-not-found',
    );
  });

  it('a connection handle from a missing ref throws a [livething] error when used', async () => {
    const { admin } = await adminOf();
    const connection = admin.connections.get(undefined as never);

    expect(() => connection.send('evt' as never, {} as never)).toThrow(/\[livething\]/);
    expect(() => connection.close()).toThrow(/\[livething\]/);
  });

  it('channel kick treats a user ref built in the Worker as local to this instance', async () => {
    const { admin } = await adminOf();
    const target = { __livething: 'user-ref', id: 'u1', instance: undefined } as const;
    await admin.channels.get('lobby').kick(target, { reason: 'banned' });
    expect(fake.adminSpies.channel.kick).toHaveBeenCalledWith(
      { ...target, instance: 'fake-instance' },
      { reason: 'banned' },
    );
  });

  it('preserves an explicit foreign user-ref instance for the engine to reject', async () => {
    const { admin } = await adminOf();
    const target = { __livething: 'user-ref', id: 'u1', instance: 'other' } as const;

    await admin.channels.get('lobby').kick(target, { reason: 'foreign' });

    expect(fake.adminSpies.channel.kick).toHaveBeenCalledWith(target, { reason: 'foreign' });
  });

  it('an api method named dup is rejected, since the stub has its own dup()', async () => {
    fake = makeFakeEngine();
    fake.adminApi.dup = vi.fn();
    const Cls = bind({} as never) as unknown as new (
      ctx: DurableObjectState,
      env: unknown,
    ) => DOInstance;
    const instance = new Cls(makeFakeDOState() as unknown as DurableObjectState, {});

    await expect(instance.admin()).rejects.toThrow(/'dup'/);
  });

  it('leaves the context plumbing off the stub surface', async () => {
    const { admin } = await adminOf();
    for (const plumbing of ['sql', 'kv', 'log', 'platform', 'schedule']) {
      expect(admin).not.toHaveProperty(plumbing);
    }
  });

  it("exposes the app's own api methods over the stub", async () => {
    const evict = vi.fn();
    fake = makeFakeEngine();
    fake.adminApi.evict = evict; // a dev-defined api method
    fake.setHibernation(false);
    // Rebuild against this staged engine.
    const Cls = bind({} as never) as unknown as new (
      ctx: DurableObjectState,
      env: unknown,
    ) => DOInstance;
    const instance = new Cls(makeFakeDOState() as unknown as DurableObjectState, {});
    const admin = await instance.admin();
    (admin.evict as (id: string) => void)('u9');
    expect(evict).toHaveBeenCalledWith('u9');
  });

  it('a dev api method cannot shadow a built-in', async () => {
    const rogue = vi.fn();
    fake = makeFakeEngine();
    fake.adminApi.broadcast = rogue; // tries to replace the built-in broadcast
    fake.setHibernation(false);
    const Cls = bind({} as never) as unknown as new (
      ctx: DurableObjectState,
      env: unknown,
    ) => DOInstance;

    const instance = new Cls(makeFakeDOState() as unknown as DurableObjectState, {});
    const admin = await instance.admin();
    admin.broadcast('evt', { n: 1 });
    // broadcast stays the prototype method, never an own dev override.
    expect(Object.hasOwn(admin, 'broadcast')).toBe(false);
    expect(rogue).toHaveBeenCalledWith('evt', { n: 1 });
  });

  it('wakes hibernated sockets before building the admin surface', async () => {
    const { state } = await adminOf({ hibernation: true });
    expect(state.getWebSockets).toHaveBeenCalled();
    expect(fake.calls.handleHibernationWake).toContainEqual({ tag: 'ws1' });
  });
});
