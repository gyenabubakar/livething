import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeDurableObjectBase,
  installPermissiveResponse,
  installWebSocketPair,
  makeFakeDOState,
  makeFakeEngine,
} from './test-utils.ts';
import type { FakeEngine } from './test-utils.ts';

const responseRestore = installPermissiveResponse();
afterAll(() => responseRestore.restore());

vi.mock('cloudflare:workers', () => ({
  DurableObject: FakeDurableObjectBase,
}));

type AdapterSetup = (
  createEngine: (runtimeOptions: unknown) => unknown,
  options: unknown,
) => unknown;

let fake: FakeEngine;

// Each serve() call re-invokes defineServerAdapter.setup. We capture the
// createEngine factory so every DO instance shares the same fake engine
// we can assert against.
vi.mock('@wskit/server/adapters', () => ({
  defineServerAdapter:
    <TOpts, TSvc>(config: { id: string; hibernation: unknown; setup: AdapterSetup }) =>
    (_handler: unknown, options: TOpts): TSvc => {
      return config.setup((runtimeOptions: unknown) => {
        fake.calls.create.push(runtimeOptions);
        return fake.engine;
      }, options) as TSvc;
    },
}));

// Import AFTER mocks are in place.
const { serve } = await import('./serve.ts');

type DOInstance = {
  fetch(req: Request): Promise<Response>;
  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer | ArrayBufferView): Promise<void>;
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean?: boolean): Promise<void>;
  webSocketError(ws: WebSocket, err: unknown): Promise<void>;
  alarm(): Promise<void>;
  shutdown(): Promise<void>;
};

function buildClass(opts?: { hibernation?: boolean }) {
  fake = makeFakeEngine();
  if (opts?.hibernation !== false) fake.setHibernation(true);
  return serve({} as never) as unknown as new (ctx: DurableObjectState, env: unknown) => DOInstance;
}

function upgradeRequest() {
  return new Request('https://do.example/', {
    headers: { Upgrade: 'websocket' },
  });
}

describe('WskitDurableObject fetch / upgrade', () => {
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

  it('upgrades and returns 101 with client socket when accepted (standard mode)', async () => {
    const Cls = buildClass({ hibernation: false });
    const state = makeFakeDOState();
    function ref(kind: 'ephemeral', group: string, key: string) {
      return { __wskit: 'tag-ref' as const, kind, group, key };
    }
    fake.stageUpgrade({ meta: { user: 'a' }, tags: [ref('ephemeral', 'role', 't1')] });

    const instance = new Cls(state as unknown as DurableObjectState, {});
    const res = await instance.fetch(upgradeRequest());

    expect(res.status).toBe(101);
    // adapter returned the client half of the pair
    const [client, server] = pairs[0]!;
    expect((res as unknown as { webSocket: unknown }).webSocket).toBe(client);
    expect(server.accept).toHaveBeenCalledTimes(1);
    expect(state.acceptWebSocket).not.toHaveBeenCalled();
    // descriptor passed into engine.accept carried meta/tags
    expect(fake.calls.accept).toHaveLength(1);
    const desc = fake.calls.accept[0]!.descriptor as {
      meta: Record<string, unknown>;
      tags: readonly { kind: string; group: string; key: string }[];
    };
    expect(desc.meta).toEqual({ user: 'a' });
    expect(desc.tags).toEqual([
      { __wskit: 'tag-ref', kind: 'ephemeral', group: 'role', key: 't1' },
    ]);
    expect(fake.calls.create).toHaveLength(1);
    expect(fake.calls.create[0]).toMatchObject({
      env: {},
      logger: expect.any(Object),
      platform: expect.any(Object),
      storage: expect.any(Object),
      timers: expect.any(Object),
      waitUntil: expect.any(Function),
    });
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

    const buf = new Uint8Array([1, 2, 3]).buffer;
    server.dispatch('message', { data: buf });
    expect(fake.connectionHandle.handleBinary).toHaveBeenCalledTimes(1);

    server.dispatch('close', { code: 1000, reason: 'bye' });
    expect(fake.connectionHandle.handleClose).toHaveBeenCalledWith(1000, 'bye');

    server.dispatch('error', new Error('boom'));
    expect(fake.connectionHandle.handleError).toHaveBeenCalled();
  });

  it('calls state.acceptWebSocket(ws) without forwarding handler tags into the cf tag store', async () => {
    // wskit tags are persisted inside the hibernation attachment, so
    // forwarding them into Cloudflare's per-socket tag store is redundant.
    // The tag store also caps at 10 tags and 256 chars per tag, which does
    // not match the wskit tag API — passing app tags through would crash
    // the upgrade for any handler that returns more or longer tags.
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    fake.stageUpgrade({
      tags: [
        { __wskit: 'tag-ref' as const, kind: 'ephemeral' as const, group: 'room', key: 'lobby' },
        { __wskit: 'tag-ref' as const, kind: 'ephemeral' as const, group: 'tier', key: 'free' },
      ],
    });

    const instance = new Cls(state as unknown as DurableObjectState, {});
    const res = await instance.fetch(upgradeRequest());

    expect(res.status).toBe(101);
    const [, server] = pairs[0]!;
    expect(state.acceptWebSocket).toHaveBeenCalledTimes(1);
    expect(state.acceptWebSocket.mock.calls[0]![0]).toBe(server);
    // No second argument: tags do not flow into Cloudflare's tag store.
    expect(state.acceptWebSocket.mock.calls[0]!).toHaveLength(1);
    expect(server.accept).not.toHaveBeenCalled();
    // addEventListener path NOT used under hibernation
    expect(server.addEventListener).not.toHaveBeenCalled();
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
    // One pair created for the rejection path
    expect(pairs).toHaveLength(1);
    const [client, server] = pairs[0]!;
    expect((res as unknown as { webSocket: unknown }).webSocket).toBe(client);
    expect(server.accept).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledWith(4002, 'bad');
    // engine.accept not called on reject
    expect(fake.calls.accept).toHaveLength(0);
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

  it('webSocketMessage forwards binary payloads through normalizeBinary', async () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    const ws = {} as unknown as WebSocket;
    const view = new Uint8Array([7, 8, 9]);
    await instance.webSocketMessage(ws, view as ArrayBufferView);

    expect(fake.connectionHandle.handleBinary).toHaveBeenCalledTimes(1);
    const arg = fake.connectionHandle.handleBinary.mock.calls[0]![0] as ArrayBuffer;
    expect(new Uint8Array(arg)).toEqual(view);
  });

  it('webSocketClose invokes connection.handleClose with code and reason', async () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    await instance.webSocketClose({} as WebSocket, 1001, 'going away', true);
    expect(fake.connectionHandle.handleClose).toHaveBeenCalledWith(1001, 'going away');
  });

  it('webSocketError forwards the error without crashing', async () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    const instance = new Cls(state as unknown as DurableObjectState, {});

    const err = new Error('ws-fail');
    await expect(instance.webSocketError({} as WebSocket, err)).resolves.toBeUndefined();
    expect(fake.connectionHandle.handleError).toHaveBeenCalledWith(err);
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
  });

  it('shutdown() under hibernation wakes every Cloudflare-managed socket before draining', async () => {
    // Pre-fix: under hibernation a fresh DO instance starts with an empty
    // engine.connections map. shutdown() walked that map and skipped every
    // hibernated socket, so a graceful drain right after wake left clients
    // open. The adapter now enumerates state.getWebSockets() and registers
    // each one with the engine before delegating.
    const Cls = buildClass({ hibernation: true });
    // Boot-time reconcile reads each socket's attachment to collect ids of
    // sockets that survived the eviction. Stub it on the mocks so the loop
    // runs cleanly; this test cares about the shutdown wake path, not the
    // reconcile content.
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

  it('provides env, storage, platform, timers, and waitUntil to the engine', () => {
    const Cls = buildClass({ hibernation: true });
    const state = makeFakeDOState();
    const env = { KEY: 'value' };
    new Cls(state as unknown as DurableObjectState, env);

    expect(fake.calls.create).toHaveLength(1);
    const engineOptions = fake.calls.create[0] as Record<string, unknown>;
    expect(engineOptions.env).toEqual(env);
    expect(engineOptions.storage).toBeDefined();
    expect(engineOptions.platform).toBeDefined();
    expect(engineOptions.timers).toBeDefined();
    expect(engineOptions.waitUntil).toBeTypeOf('function');
    expect(engineOptions.logger).toBeDefined();

    // The same Logger instance the adapter passes into engine creation is also
    // passed into the storage providers, so kv warnings flow through one logger.
    const adapterLogger = engineOptions.logger as Record<string, unknown>;
    expect(typeof adapterLogger.info).toBe('function');
    expect(typeof adapterLogger.warn).toBe('function');
    expect(typeof adapterLogger.error).toBe('function');

    // waitUntil wrapper forwards through to state.waitUntil
    const wrapper = engineOptions.waitUntil as (p: Promise<unknown>) => void;
    const p = Promise.resolve();
    wrapper(p);
    expect(state.waitUntil).toHaveBeenCalledWith(p);
  });
});
