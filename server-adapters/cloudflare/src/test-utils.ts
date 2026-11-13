import { vi } from 'vitest';
import type { AuthDecision, ConnectionHandle, Engine } from '@livething/server/adapters';

// `WebSocketRequestResponsePair` is a Workers runtime global; Node test runs
// lack it, so stand it in for the adapter's setWebSocketAutoResponse wiring.
const globalScope = globalThis as { WebSocketRequestResponsePair?: unknown };
globalScope.WebSocketRequestResponsePair ??= class {
  constructor(
    public readonly request: string,
    public readonly response: string,
  ) {}
};

/**
 * Minimal mock WebSocket with the methods the adapter exercises:
 * accept/send/close and addEventListener for standard mode.
 */
export interface FakeWebSocket {
  /** `1` is open, `3` is closed, as on the Workers `WebSocket`. */
  readyState: number;
  /** Workers' default is `'blob'` from compatibility date 2026-03-17. */
  binaryType: 'blob' | 'arraybuffer';
  /** The `binaryType` when `accept()` ran. */
  binaryTypeAtAccept?: 'blob' | 'arraybuffer';
  accept: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  dispatch: (type: string, event: unknown) => void;
}

function makeFakeWebSocket(): FakeWebSocket {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const ws: FakeWebSocket = {
    readyState: 1,
    binaryType: 'blob',
    accept: vi.fn(() => {
      ws.binaryTypeAtAccept = ws.binaryType;
    }),
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
      const bucket = listeners.get(type) ?? [];
      bucket.push(handler);
      listeners.set(type, bucket);
    }),
    dispatch(type, event) {
      const bucket = listeners.get(type) ?? [];
      for (const fn of bucket) fn(event);
    },
  };

  return ws;
}

/**
 * Install a global WebSocketPair factory that returns a pair of FakeWebSockets.
 * Returns the factory so tests can read the pairs it handed out.
 */
export function installWebSocketPair(): { pairs: Array<[FakeWebSocket, FakeWebSocket]> } {
  const pairs: Array<[FakeWebSocket, FakeWebSocket]> = [];
  (
    globalThis as unknown as { WebSocketPair: new () => [FakeWebSocket, FakeWebSocket] }
  ).WebSocketPair = function WebSocketPair() {
    const client = makeFakeWebSocket();
    const server = makeFakeWebSocket();
    const pair: [FakeWebSocket, FakeWebSocket] = [client, server];
    pairs.push(pair);

    return pair;
  } as unknown as new () => [FakeWebSocket, FakeWebSocket];
  return { pairs };
}

/**
 * Minimal DurableObjectState with spyable storage + alarm hooks.
 */
export type FakeDOState = {
  id: { toString: () => string };
  storageMap: Map<string, unknown>;
  waitUntil: ReturnType<typeof vi.fn>;
  blockConcurrencyWhile: ReturnType<typeof vi.fn>;
  acceptWebSocket: ReturnType<typeof vi.fn>;
  getWebSockets: ReturnType<typeof vi.fn>;
  setWebSocketAutoResponse: ReturnType<typeof vi.fn>;
  storage: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    setAlarm: ReturnType<typeof vi.fn>;
    deleteAlarm: ReturnType<typeof vi.fn>;
    sql: { exec: ReturnType<typeof vi.fn> };
  };
};

export function makeFakeDOState(overrides?: Partial<FakeDOState>): FakeDOState {
  return { ...baseFakeState(), ...overrides };
}

function baseFakeState(): FakeDOState {
  const storageMap = new Map<string, unknown>();

  return {
    id: { toString: () => 'fake-instance' },
    storageMap,
    waitUntil: vi.fn(),
    blockConcurrencyWhile: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn(() => [] as unknown[]),
    setWebSocketAutoResponse: vi.fn(),
    storage: {
      get: vi.fn(async (key: string) => storageMap.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        storageMap.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        storageMap.delete(key);
      }),
      list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => {
        const out = new Map<string, unknown>();
        for (const [k, v] of storageMap) {
          if (!prefix || k.startsWith(prefix)) out.set(k, v);
        }

        return out;
      }),
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
      sql: {
        exec: vi.fn(),
      },
    },
  };
}

/**
 * Build a fake Engine that records calls and lets tests stage authenticate decisions
 * plus per-connection handle behavior.
 */
export interface FakeEngine {
  engine: Engine;
  calls: {
    initialize: number;
    create: unknown[];
    authenticate: Request[];
    accept: Array<{ ws: unknown; descriptor: unknown }>;
    handleHibernationWake: unknown[];
    handleAlarm: number;
    handleShutdown: number;
    handleShutdownOptions: unknown[][];
    reconcileConnections: Array<ReadonlySet<string>>;
    restoreHibernatedConnections: unknown[][];
  };
  stageAuth: (decision: AuthDecision | (() => Promise<AuthDecision> | AuthDecision)) => void;
  setHibernation: (enabled: boolean) => void;
  setRestoreFailure: (error?: unknown) => void;
  connectionHandle: {
    handleMessage: ReturnType<typeof vi.fn>;
    handleBinaryMessage: ReturnType<typeof vi.fn>;
    handleClose: ReturnType<typeof vi.fn>;
    handleError: ReturnType<typeof vi.fn>;
  };
  /** The object `engine.admin()` returns; tests add dev methods and assert delegation. */
  adminApi: Record<string, unknown>;
  /** Spies reached through the context's managers, which `adminApi` nests. */
  adminSpies: {
    connection: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
    user: {
      broadcast: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      setMeta: ReturnType<typeof vi.fn>;
    };
    channel: {
      broadcast: ReturnType<typeof vi.fn>;
      members: ReturnType<typeof vi.fn>;
      kick: ReturnType<typeof vi.fn>;
    };
  };
}

export function makeFakeEngine(): FakeEngine {
  const calls: FakeEngine['calls'] = {
    initialize: 0,
    create: [],
    authenticate: [],
    accept: [],
    handleHibernationWake: [],
    handleAlarm: 0,
    handleShutdown: 0,
    handleShutdownOptions: [],
    reconcileConnections: [],
    restoreHibernatedConnections: [],
  };

  let stagedAuth: AuthDecision | (() => Promise<AuthDecision> | AuthDecision) = {};
  let hibernation = false;
  let restoreFailure: unknown;

  // What engine.admin() returns: the connectionless context (spied), which the
  // app's own api is merged into. The adapter wraps its managers in RpcTargets,
  // so the managers here carry the same shape the real context builds.
  const adminConnection = {
    id: 'c1',
    userId: 'u1',
    ref: () => ({ __livething: 'connection-ref', id: 'c1', instance: undefined, userId: 'u1' }),
  };

  const connection = { send: vi.fn(() => true), close: vi.fn() };
  const user = {
    ref: () => ({ __livething: 'user-ref', id: 'u1', instance: 'fake-instance' }),
    broadcast: vi.fn(() => 2),
    close: vi.fn(),
    setMeta: vi.fn(),
    connections: () => [adminConnection],
    info: () => null,
    isOnline: () => true,
  };

  const channel = {
    broadcast: vi.fn(),
    members: vi.fn(() => [adminConnection]),
    kick: vi.fn(async () => {}),
  };

  const adminApi: Record<string, unknown> = {
    broadcast: vi.fn(),
    purgeUser: vi.fn(async () => {}),
    closeConnections: vi.fn(),
    connections: {
      get: vi.fn(() => connection),
      all: vi.fn(() => [adminConnection]),
    },
    users: { get: vi.fn(() => user) },
    channels: { get: vi.fn(() => channel), broadcast: vi.fn() },
    connectionCount: 3,
    sql: {},
    kv: {},
    log: {},
    platform: {},
    schedule: vi.fn(),
    cancelScheduled: vi.fn(),
  };

  const connectionHandle: FakeEngine['connectionHandle'] = {
    handleMessage: vi.fn(async () => {}),
    handleBinaryMessage: vi.fn(async () => {}),
    handleClose: vi.fn(async () => {}),
    handleError: vi.fn(async () => {}),
  };

  const engine = {
    setInstanceId: vi.fn(),
    initialize: vi.fn(async () => {
      calls.initialize += 1;
    }),
    authenticate: vi.fn(async (req: Request) => {
      calls.authenticate.push(req);
      const v = typeof stagedAuth === 'function' ? await stagedAuth() : stagedAuth;
      return v;
    }),
    accept: vi.fn((ws: unknown, descriptor: unknown) => {
      calls.accept.push({ ws, descriptor });
      return connectionHandle as unknown as ConnectionHandle;
    }),
    usesHibernation: () => hibernation,
    handleHibernationWake: vi.fn((ws: unknown) => {
      calls.handleHibernationWake.push(ws);
      return connectionHandle as unknown as ConnectionHandle;
    }),
    handleAlarm: vi.fn(async () => {
      calls.handleAlarm += 1;
    }),
    handleShutdown: vi.fn(async (...options: unknown[]) => {
      calls.handleShutdown += 1;
      calls.handleShutdownOptions.push(options);
    }),
    reconcileConnections: vi.fn((surviving: ReadonlySet<string>) => {
      calls.reconcileConnections.push(surviving);
    }),
    restoreHibernatedConnections: vi.fn(async (sockets: Iterable<unknown>) => {
      calls.restoreHibernatedConnections.push([...sockets]);
      if (restoreFailure !== undefined) throw restoreFailure;
    }),
    admin: vi.fn(() => adminApi),
  } as unknown as Engine;

  return {
    engine,
    calls,
    stageAuth(decision) {
      stagedAuth = decision;
    },
    setHibernation(enabled) {
      hibernation = enabled;
    },
    setRestoreFailure(error) {
      restoreFailure = error;
    },
    connectionHandle,
    adminApi,
    adminSpies: { connection, user, channel },
  };
}

/**
 * Replace the global `Response` with a permissive stub that accepts status 101
 * (Node's built-in throws on 1xx statuses outside the spec-permitted range).
 * Returns a restore() to put the original back.
 */
export function installPermissiveResponse(): { restore: () => void } {
  const original = globalThis.Response;

  class TestResponse {
    readonly status: number;
    readonly body: unknown;
    readonly init: Record<string, unknown>;
    constructor(body: BodyInit | null, init: Record<string, unknown> = {}) {
      this.body = body;
      this.init = init;
      this.status = (init.status as number | undefined) ?? 200;
      Object.assign(this, init);
    }
    text() {
      return Promise.resolve(typeof this.body === 'string' ? this.body : String(this.body ?? ''));
    }
  }

  (globalThis as unknown as { Response: unknown }).Response = TestResponse;
  return {
    restore() {
      (globalThis as unknown as { Response: unknown }).Response = original;
    },
  };
}

/**
 * Minimal `DurableObject` base stand-in for the cloudflare:workers import.
 */
export class FakeDurableObjectBase<Env = unknown> {
  public ctx: unknown;
  public env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
