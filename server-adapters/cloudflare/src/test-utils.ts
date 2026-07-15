import { vi } from 'vitest';
import type { ConnectionHandle, Engine, UpgradeDecision } from '@wskit/server/adapters';

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
  accept: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  listeners: Map<string, Array<(event: unknown) => void>>;
  dispatch: (type: string, event: unknown) => void;
}

export function makeFakeWebSocket(): FakeWebSocket {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const ws: FakeWebSocket = {
    accept: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    listeners,
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
  storageMap: Map<string, unknown>;
  getAlarmTime: () => number | null;
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
    getAlarm: ReturnType<typeof vi.fn>;
    deleteAlarm: ReturnType<typeof vi.fn>;
    sql: { exec: ReturnType<typeof vi.fn> };
  };
};

export function makeFakeDOState(overrides?: Partial<FakeDOState>): FakeDOState {
  return { ...baseFakeState(), ...overrides };
}

function baseFakeState(): FakeDOState {
  const storageMap = new Map<string, unknown>();
  let alarmTime: number | null = null;

  return {
    storageMap,
    getAlarmTime: () => alarmTime,
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
      setAlarm: vi.fn(async (time: number) => {
        alarmTime = time;
      }),
      getAlarm: vi.fn(async () => alarmTime),
      deleteAlarm: vi.fn(async () => {
        alarmTime = null;
      }),
      sql: {
        exec: vi.fn(),
      },
    },
  };
}

/**
 * Build a fake Engine that records calls and lets tests stage upgrade decisions
 * plus per-connection handle behavior.
 */
export interface FakeEngine {
  engine: Engine;
  calls: {
    initialize: number;
    create: unknown[];
    handleUpgrade: Request[];
    accept: Array<{ ws: unknown; descriptor: unknown }>;
    handleHibernationWake: unknown[];
    handleAlarm: number;
    handleShutdown: number;
    reconcileConnections: Array<ReadonlySet<string>>;
    restoreHibernatedConnections: unknown[][];
  };
  stageUpgrade: (
    decision: UpgradeDecision | (() => Promise<UpgradeDecision> | UpgradeDecision),
  ) => void;
  setHibernation: (enabled: boolean) => void;
  connectionHandle: {
    handleMessage: ReturnType<typeof vi.fn>;
    handleClose: ReturnType<typeof vi.fn>;
    handleError: ReturnType<typeof vi.fn>;
  };
  /** The object `engine.admin()` returns; tests add dev methods and assert delegation. */
  adminApi: Record<string, unknown>;
}

export function makeFakeEngine(): FakeEngine {
  const calls: FakeEngine['calls'] = {
    initialize: 0,
    create: [],
    handleUpgrade: [],
    accept: [],
    handleHibernationWake: [],
    handleAlarm: 0,
    handleShutdown: 0,
    reconcileConnections: [],
    restoreHibernatedConnections: [],
  };

  let stagedUpgrade: UpgradeDecision | (() => Promise<UpgradeDecision> | UpgradeDecision) = {};
  let hibernation = false;

  // What engine.admin() returns: built-in ops (spied) plus non-function plumbing
  // that WSKitAdmin should skip when exposing methods over the stub.
  const adminApi: Record<string, unknown> = {
    broadcast: vi.fn(),
    purgeIdentity: vi.fn(async () => {}),
    closeConnections: vi.fn(),
    getConnections: vi.fn(() => []),
    sql: {},
    channels: { get: vi.fn() },
    connectionCount: 0,
  };

  const connectionHandle: FakeEngine['connectionHandle'] = {
    handleMessage: vi.fn(async () => {}),
    handleClose: vi.fn(async () => {}),
    handleError: vi.fn(async () => {}),
  };

  const engine = {
    initialize: vi.fn(async () => {
      calls.initialize += 1;
    }),
    handleUpgrade: vi.fn(async (req: Request) => {
      calls.handleUpgrade.push(req);
      const v = typeof stagedUpgrade === 'function' ? await stagedUpgrade() : stagedUpgrade;
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
    handleShutdown: vi.fn(async () => {
      calls.handleShutdown += 1;
    }),
    reconcileConnections: vi.fn((surviving: ReadonlySet<string>) => {
      calls.reconcileConnections.push(surviving);
    }),
    restoreHibernatedConnections: vi.fn((sockets: Iterable<unknown>) => {
      calls.restoreHibernatedConnections.push([...sockets]);
    }),
    admin: vi.fn(() => adminApi),
  } as unknown as Engine;

  return {
    engine,
    calls,
    stageUpgrade(decision) {
      stagedUpgrade = decision;
    },
    setHibernation(enabled) {
      hibernation = enabled;
    },
    connectionHandle,
    adminApi,
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
