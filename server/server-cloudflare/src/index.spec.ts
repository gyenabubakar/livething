import { outgoing, received, server, t } from '@wskit/server-codegen';
import { incoming } from '@wskit/server-codegen/incoming';
import { onUpgrade } from '@wskit/server-codegen/lifecycle';
import { scheduled } from '@wskit/server-codegen/scheduled';
import { describe, expect, it } from 'vitest';
import { serve } from './index.ts';

class FakeSqlResult {
  constructor(private readonly rows: Record<string, unknown>[] = []) {}

  toArray(): Record<string, unknown>[] {
    return [...this.rows];
  }

  one(): Record<string, unknown> | null {
    return this.rows[0] ?? null;
  }

  raw(): unknown[][] {
    return this.rows.map((row) => Object.values(row));
  }
}

function createState() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  const sockets: FakeWebSocket[] = [];

  return {
    accepted: sockets,
    state: {
      storage: {
        sql: {
          exec(query: string) {
            if (
              query.startsWith('CREATE TABLE IF NOT EXISTS _wskit_scheduled') ||
              query.startsWith('DELETE FROM _wskit_scheduled')
            ) {
              return new FakeSqlResult();
            }
            if (query.startsWith('SELECT id, taskId, time, data, everyMs FROM _wskit_scheduled')) {
              return new FakeSqlResult();
            }
            if (query.startsWith('INSERT INTO _wskit_scheduled')) {
              return new FakeSqlResult();
            }
            return new FakeSqlResult();
          },
          transactionSync<T>(closure: () => T): T {
            return closure();
          },
        },
        async get(key: string) {
          return values.get(key);
        },
        async put(key: string, value: unknown) {
          values.set(key, value);
        },
        async delete(key: string) {
          values.delete(key);
        },
        async list(options?: { prefix?: string }) {
          return {
            keys: [...values.keys()]
              .filter((key) => key.startsWith(options?.prefix ?? ''))
              .map((name) => ({ name })),
          };
        },
        async getAlarm() {
          return alarm;
        },
        async setAlarm(timeMs: number) {
          alarm = timeMs;
        },
        async deleteAlarm() {
          alarm = null;
        },
        transactionSync<T>(closure: () => T): T {
          return closure();
        },
      },
      blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T> {
        return closure();
      },
      acceptWebSocket(socket: FakeWebSocket) {
        sockets.push(socket);
      },
      getWebSockets() {
        return [...sockets];
      },
      waitUntil() {},
    },
  };
}

class FakeWebSocket {
  sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  closed: { code?: number; reason?: string }[] = [];
  attachment: unknown = {};

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

interface TestDurableObject {
  fetch(request: Request): Promise<{ status: number; text(): Promise<string> }>;
  webSocketMessage(
    ws: FakeWebSocket,
    message: string | ArrayBuffer | ArrayBufferView,
  ): Promise<void>;
  alarm(): Promise<void>;
}

function installResponseShim() {
  class FakeResponse {
    readonly status: number;
    readonly webSocket?: unknown;
    private readonly body: unknown;

    constructor(body: unknown, init?: ResponseInit & { webSocket?: unknown }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.webSocket = init?.webSocket;
    }

    async text(): Promise<string> {
      return typeof this.body === 'string' ? this.body : '';
    }
  }

  Object.assign(globalThis, {
    Response: FakeResponse as unknown as typeof Response,
  });
}

describe('@wskit/server-cloudflare', () => {
  it('accepts websocket upgrades and routes messages through the engine', async () => {
    const chat = server('cf-chat', {
      _incoming: incoming,
      _outgoing: outgoing,
    }).define(
      outgoing('message', t<{ text: string }>()),
      incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (ctx, payload) => {
          ctx.send('message', payload);
        },
      ),
    );

    const DurableObjectClass = serve(chat);
    const { state, accepted } = createState();
    const object = new DurableObjectClass(state as never, {}) as unknown as TestDurableObject;

    class FakeWebSocketPair {
      0 = new FakeWebSocket();
      1 = new FakeWebSocket();
    }

    Object.assign(globalThis, {
      WebSocketPair: FakeWebSocketPair,
    });
    installResponseShim();

    const response = await object.fetch(
      new Request('https://example.com/ws', {
        headers: { Upgrade: 'websocket' },
      }),
    );

    expect(response.status).toBe(101);
    expect(accepted).toHaveLength(1);

    const serverSocket = accepted[0]!;
    await object.webSocketMessage(
      serverSocket as never,
      JSON.stringify({ event: 'echo', payload: { text: 'hi' } }),
    );

    expect(
      serverSocket.sent.some(
        (entry) => typeof entry === 'string' && entry.includes('"event":"message"'),
      ),
    ).toBe(true);
  });

  it('rejects upgrades when onUpgrade throws', async () => {
    const protectedHandler = server('cf-protected', {
      _onUpgrade: onUpgrade,
    }).define(
      onUpgrade(async () => {
        throw { __wskit: 'reject-upgrade', code: 401, reason: 'Unauthorized' };
      }),
    );

    const DurableObjectClass = serve(protectedHandler);
    const { state } = createState();
    const object = new DurableObjectClass(state as never, {}) as unknown as TestDurableObject;
    installResponseShim();

    const response = await object.fetch(
      new Request('https://example.com/ws', {
        headers: { Upgrade: 'websocket' },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toContain('Unauthorized');
  });

  it('runs alarms through scheduled tasks', async () => {
    const runs: string[] = [];
    const scheduledHandler = server('cf-scheduled', {
      _incoming: incoming,
      _scheduled: scheduled,
    }).define(
      scheduled('cleanup', async (_ctx: unknown, data: { job: string }) => {
        runs.push(data.job);
      }),
      incoming(
        received('queue-cleanup', (value: unknown) => value as { job: string }),
        async (
          ctx: { schedule(taskId: string, options: { time: number; data?: unknown }): void },
          payload,
        ) => {
          ctx.schedule('cleanup', { time: Date.now(), data: payload });
        },
      ),
    );

    const DurableObjectClass = serve(scheduledHandler);
    const { state } = createState();
    const object = new DurableObjectClass(state as never, {}) as unknown as TestDurableObject;

    class FakeWebSocketPair {
      0 = new FakeWebSocket();
      1 = new FakeWebSocket();
    }

    Object.assign(globalThis, {
      WebSocketPair: FakeWebSocketPair,
    });
    installResponseShim();

    await object.fetch(
      new Request('https://example.com/ws', {
        headers: { Upgrade: 'websocket' },
      }),
    );

    const serverSocket = state.getWebSockets()[0]!;
    await object.webSocketMessage(
      serverSocket,
      JSON.stringify({ event: 'queue-cleanup', payload: { job: 'cleanup' } }),
    );
    await object.alarm();
    expect(runs).toEqual(['cleanup']);
  });
});
