import { WskitError } from '@wskit/core';
import * as AckPrimitive from '~/ack/index.ts';
import * as ChannelPrimitive from '~/channel/index.ts';
import * as DedupPrimitive from '~/dedup/index.ts';
import * as HeartbeatPrimitive from '~/heartbeat/index.ts';
import * as HibernationPrimitive from '~/hibernation/index.ts';
import * as IncomingPrimitive from '~/incoming/index.ts';
import {
  defineModule,
  onBeforeSubscribe,
  onBinary,
  onConnect,
  onDisconnect,
  onError,
  onInit,
  onShutdown,
  onSubscribe,
  onUnsubscribe,
  onUpgrade,
  onValidationError,
  outgoing,
  received,
  scheduled,
  server,
  t,
} from '~/index.ts';
import * as ReplayPrimitive from '~/replay/index.ts';
import * as SequencePrimitive from '~/sequence/index.ts';
import * as StreamPrimitive from '~/stream/index.ts';
import { describe, expect, it, vi } from 'vitest';
import { Engine } from './index.ts';

class FakeSqlResult {
  constructor(private readonly rows: Record<string, unknown>[]) {}

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

class FakeSqlProvider {
  sequence = new Map<
    string,
    {
      scope: string;
      nextSeq: number;
    }
  >();
  replay = new Map<
    string,
    {
      rowKey: string;
      messageId: string;
      seq: number;
      event: string;
      payload: string;
      namespace: string | null;
      channel: string | null;
      channelScope: string | null;
      snapshotKey: string | null;
      createdAt: number;
    }
  >();
  scheduled = new Map<
    string,
    {
      id: string;
      taskId: string;
      time: number;
      data: string | null;
      everyMs: number | null;
      attempts: number;
      recurring: number;
      retry: number;
    }
  >();
  scheduledDlq = new Map<
    string,
    {
      id: string;
      taskId: string;
      time: number;
      failedAt: number;
      data: string | null;
      attempts: number;
      error: string;
    }
  >();

  exec(query: string, ...params: unknown[]) {
    const normalizedQuery = query.replaceAll(/\s+/g, ' ').trim();

    if (normalizedQuery.startsWith('CREATE TABLE IF NOT EXISTS _wskit_scheduled_dlq')) {
      return new FakeSqlResult([]);
    }

    if (normalizedQuery.startsWith('CREATE TABLE IF NOT EXISTS _wskit_scheduled')) {
      return new FakeSqlResult([]);
    }

    if (normalizedQuery.startsWith('CREATE TABLE IF NOT EXISTS _wskit_replay')) {
      return new FakeSqlResult([]);
    }

    if (normalizedQuery.startsWith('CREATE TABLE IF NOT EXISTS _wskit_sequence')) {
      return new FakeSqlResult([]);
    }

    if (normalizedQuery.startsWith('CREATE INDEX IF NOT EXISTS idx_wskit_replay_')) {
      return new FakeSqlResult([]);
    }

    if (
      normalizedQuery.startsWith(
        'SELECT id, taskId, time, data, everyMs, attempts, recurring, retry FROM _wskit_scheduled',
      )
    ) {
      return new FakeSqlResult([...this.scheduled.values()]);
    }

    if (
      normalizedQuery.startsWith(
        'SELECT id, taskId, time, failedAt, data, attempts, error FROM _wskit_scheduled_dlq',
      )
    ) {
      return new FakeSqlResult([...this.scheduledDlq.values()]);
    }

    if (normalizedQuery.startsWith('SELECT nextSeq FROM _wskit_sequence WHERE scope = ?')) {
      const [scope] = params;
      const row = this.sequence.get(String(scope));
      return new FakeSqlResult(row ? [row] : []);
    }

    if (
      normalizedQuery.startsWith(
        'SELECT rowKey, messageId, seq, event, payload, namespace, channel, channelScope, snapshotKey, createdAt FROM _wskit_replay WHERE channel IS ?',
      )
    ) {
      const [channel, channelScope, since] = params;
      return new FakeSqlResult(
        [...this.replay.values()]
          .filter(
            (row) =>
              row.channel === ((channel as string | null) ?? null) &&
              row.channelScope === ((channelScope as string | null) ?? null) &&
              row.seq > Number(since),
          )
          .sort((a, b) => a.seq - b.seq),
      );
    }

    if (
      normalizedQuery.startsWith(
        'SELECT rowKey, messageId, seq, event, payload, namespace, channel, channelScope, snapshotKey, createdAt FROM _wskit_replay WHERE namespace IS NULL',
      )
    ) {
      const [since] = params;
      return new FakeSqlResult(
        [...this.replay.values()]
          .filter(
            (row) =>
              row.namespace === null &&
              row.channel === null &&
              row.channelScope === null &&
              row.seq > Number(since),
          )
          .sort((a, b) => a.seq - b.seq),
      );
    }

    if (normalizedQuery.startsWith('DELETE FROM _wskit_scheduled_dlq')) {
      this.scheduledDlq.clear();
      return new FakeSqlResult([]);
    }

    if (normalizedQuery.startsWith('DELETE FROM _wskit_scheduled')) {
      this.scheduled.clear();
      return new FakeSqlResult([]);
    }

    if (normalizedQuery.startsWith('DELETE FROM _wskit_replay WHERE createdAt < ?')) {
      const [cutoff] = params;

      for (const [key, row] of this.replay) {
        if (row.createdAt < Number(cutoff)) {
          this.replay.delete(key);
        }
      }

      return new FakeSqlResult([]);
    }

    if (normalizedQuery.startsWith('DELETE FROM _wskit_replay WHERE rowKey IN (')) {
      const [namespace, channel, channelScope, offset] = params;
      const candidates = [...this.replay.values()]
        .filter(
          (row) =>
            row.namespace === ((namespace as string | null) ?? null) &&
            row.channel === ((channel as string | null) ?? null) &&
            row.channelScope === ((channelScope as string | null) ?? null),
        )
        .sort((a, b) => b.seq - a.seq)
        .slice(Number(offset));

      for (const row of candidates) {
        this.replay.delete(row.rowKey);
      }

      return new FakeSqlResult([]);
    }

    if (normalizedQuery.startsWith('INSERT INTO _wskit_scheduled ')) {
      this.scheduled.set(String(params[0]), {
        id: String(params[0]),
        taskId: String(params[1]),
        time: Number(params[2]),
        data: (params[3] as string | null) ?? null,
        everyMs: (params[4] as number | null) ?? null,
        attempts: Number(params[5]),
        recurring: Number(params[6]),
        retry: Number(params[7]),
      });
      return new FakeSqlResult([]);
    }

    if (normalizedQuery.startsWith('INSERT INTO _wskit_scheduled_dlq')) {
      this.scheduledDlq.set(String(params[0]), {
        id: String(params[0]),
        taskId: String(params[1]),
        time: Number(params[2]),
        failedAt: Number(params[3]),
        data: (params[4] as string | null) ?? null,
        attempts: Number(params[5]),
        error: String(params[6]),
      });
      return new FakeSqlResult([]);
    }

    if (normalizedQuery.startsWith('INSERT OR REPLACE INTO _wskit_replay')) {
      this.replay.set(String(params[0]), {
        rowKey: String(params[0]),
        messageId: String(params[1]),
        seq: Number(params[2]),
        event: String(params[3]),
        payload: String(params[4]),
        namespace: (params[5] as string | null) ?? null,
        channel: (params[6] as string | null) ?? null,
        channelScope: (params[7] as string | null) ?? null,
        snapshotKey: (params[8] as string | null) ?? null,
        createdAt: Number(params[9]),
      });
      return new FakeSqlResult([]);
    }

    if (
      normalizedQuery.startsWith('INSERT INTO _wskit_sequence ( scope, nextSeq ) VALUES (?, ?)')
    ) {
      this.sequence.set(String(params[0]), {
        scope: String(params[0]),
        nextSeq: Number(params[1]),
      });
      return new FakeSqlResult([]);
    }

    if (normalizedQuery.startsWith('UPDATE _wskit_sequence SET nextSeq = ? WHERE scope = ?')) {
      this.sequence.set(String(params[1]), {
        scope: String(params[1]),
        nextSeq: Number(params[0]),
      });
      return new FakeSqlResult([]);
    }

    return new FakeSqlResult([]);
  }

  transaction<T>(fn: (tx: { exec(query: string, ...params: unknown[]): FakeSqlResult }) => T): T {
    return fn({ exec: this.exec.bind(this) });
  }
}

class FakeKvProvider {
  private readonly store = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.store.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix = ''): Promise<string[]> {
    return [...this.store.keys()].filter((key) => key.startsWith(prefix));
  }
}

function createStorage() {
  return {
    sql: new FakeSqlProvider(),
    kv: new FakeKvProvider(),
  };
}

function createTimers() {
  const alarms: number[] = [];
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;

  return {
    alarms,
    timers: {
      async setAlarm(timeMs: number) {
        alarms.push(timeMs);
      },
      async deleteAlarm() {},
      async getAlarm() {
        return alarms.at(-1) ?? null;
      },
      setTimeout(callback: () => void) {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      },
      clearTimeout(handle: unknown) {
        callbacks.delete(Number(handle));
      },
    },
    flushTimeouts() {
      const pending = [...callbacks.values()];
      callbacks.clear();

      for (const callback of pending) {
        callback();
      }
    },
  };
}

function attachTestAdapter(engine: Engine, storage = createStorage()) {
  engine.setStorage(storage);
  engine.setTimerProvider(createTimers().timers);
  engine.setWaitUntil(() => {});
  return storage;
}

function createDescriptor(meta: Record<string, unknown> = {}) {
  const sent: { event: string; payload?: Record<string, unknown> }[] = [];
  const rawSent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];

  return {
    sent,
    rawSent,
    closed,
    descriptor: {
      send(data: string) {
        try {
          sent.push(JSON.parse(data) as { event: string; payload?: Record<string, unknown> });
        } catch {
          rawSent.push(data);
        }
      },
      sendBinary() {},
      close(code?: number, reason?: string) {
        closed.push({ code, reason });
      },
      bufferedAmount() {
        return 0;
      },
      meta,
      tags: [] as const,
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Engine', () => {
  it('lets sequence own _seq injection while skipping protocol events', async () => {
    const ping = received('echo', (value: unknown) => value as { text: string });

    const handler = server('engine-sequence', {
      _ack: AckPrimitive.ack,
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
      _sequence: SequencePrimitive.sequence,
    }).define(
      SequencePrimitive.sequence(),
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        ping,
        async (
          ctx: { ack(): void; send(event: 'message', payload: { text: string }): void },
          payload,
        ) => {
          ctx.ack();
          ctx.send('message', { text: payload.text });
          ctx.send('message', { text: `${payload.text}!` });
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    const ws = createDescriptor();
    const connection = engine.accept(Symbol('ws'), ws.descriptor);
    connection.handleMessage(
      JSON.stringify({
        event: 'echo',
        payload: { text: 'pong', _ackId: 'ack-1' },
      }),
    );
    await flushAsyncWork();

    expect(ws.sent).toEqual([
      { event: '_ack', payload: { _ackId: 'ack-1' } },
      { event: 'message', payload: { text: 'pong', _seq: 1 } },
      { event: 'message', payload: { text: 'pong!', _seq: 2 } },
    ]);
  });

  it('lets dedup own _messageId injection while skipping protocol events', async () => {
    const ping = received('echo', (value: unknown) => value as { text: string });

    const handler = server('engine-dedup', {
      _ack: AckPrimitive.ack,
      _dedup: DedupPrimitive.dedup,
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
    }).define(
      DedupPrimitive.dedup(),
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        ping,
        async (
          ctx: { ack(): void; send(event: 'message', payload: { text: string }): void },
          payload,
        ) => {
          ctx.ack();
          ctx.send('message', { text: payload.text });
          ctx.send('message', { text: `${payload.text}!` });
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    const ws = createDescriptor();
    const connection = engine.accept(Symbol('ws-dedup'), ws.descriptor);
    connection.handleMessage(
      JSON.stringify({
        event: 'echo',
        payload: { text: 'pong', _ackId: 'ack-1' },
      }),
    );
    await flushAsyncWork();

    expect(ws.sent[0]).toEqual({
      event: '_ack',
      payload: { _ackId: 'ack-1' },
    });
    expect(ws.sent[1]).toMatchObject({
      event: 'message',
      payload: { text: 'pong' },
    });
    expect(ws.sent[2]).toMatchObject({
      event: 'message',
      payload: { text: 'pong!' },
    });
    expect(ws.sent[1]?.payload?._messageId).toMatch(/^msg_/);
    expect(ws.sent[2]?.payload?._messageId).toMatch(/^msg_/);
    expect(ws.sent[1]?.payload?._messageId).not.toBe(ws.sent[2]?.payload?._messageId);
  });

  it('lets heartbeat own idle timeout refresh through connect and activity hooks', async () => {
    const handler = server('engine-heartbeat', {
      _heartbeat: HeartbeatPrimitive.heartbeat,
      _incoming: IncomingPrimitive.incoming,
    }).define(
      HeartbeatPrimitive.heartbeat({ timeout: 30_000 }),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async () => {},
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });
    const storage = createStorage();
    const timerState = createTimers();

    engine.setStorage(storage);
    engine.setTimerProvider(timerState.timers);
    engine.setWaitUntil(() => {});
    await engine.initialize();

    const ws = createDescriptor();
    const connection = engine.accept(Symbol('ws-heartbeat'), ws.descriptor);

    expect(ws.closed).toEqual([]);

    connection.handleMessage(JSON.stringify({ event: 'echo', payload: { text: 'pong' } }));
    await flushAsyncWork();

    timerState.flushTimeouts();

    expect(ws.closed).toEqual([{ code: 4004, reason: 'Heartbeat timeout' }]);
  });

  it('runs scheduled tasks and reschedules recurring tasks', async () => {
    const runs: unknown[] = [];
    const flushTask = scheduled(
      'flush',
      async (_ctx, data: { force: boolean }) => {
        runs.push(data);
      },
      { every: 1_000 },
    );
    const queueMessage = received('queue-task', (value: unknown) => value as { force: boolean });

    const handler = server('engine-schedule', {
      _incoming: IncomingPrimitive.incoming,
      _scheduled: scheduled,
    }).define(
      flushTask,
      IncomingPrimitive.incoming(
        queueMessage,
        async (
          ctx: { schedule(taskId: string, options: { time: number; data?: unknown }): void },
          payload,
        ) => {
          ctx.schedule('flush', { time: Date.now(), data: payload });
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });
    const storage = createStorage();
    const { timers, alarms } = createTimers();

    engine.setStorage(storage);
    engine.setTimerProvider(timers);
    engine.setWaitUntil(() => {});
    await engine.initialize();

    const { descriptor } = createDescriptor();
    const conn = engine.accept(Symbol('ws'), descriptor);
    conn.handleMessage(JSON.stringify({ event: 'queue-task', payload: { force: true } }));
    await flushAsyncWork();

    // One recurring baseline run exists already, and ctx.schedule(...) adds a
    // separate one-shot run without changing that recurring schedule.
    expect(storage.sql.scheduled.size).toBe(2);

    await engine.handleAlarm();

    expect(runs).toEqual([{ force: true }]);
    expect(storage.sql.scheduled.size).toBe(1);
    expect(alarms.length).toBeGreaterThan(0);
  });

  it('prefixes module outgoing events on connect', async () => {
    const Analytics = defineModule({
      id: 'acme:analytics',
      key: Symbol('acme:analytics'),
      outgoing: [outgoing('flushed', t<{ count: number }>())] as const,
      setup(_args, hooks) {
        hooks.onConnect(async (ctx) => {
          ctx.send('flushed', { count: 1 });
        });

        return () => ({});
      },
    });

    const handler = server('engine-modules', {
      _outgoing: outgoing,
    }).define(Analytics({}));

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    const ws = createDescriptor();
    engine.accept(Symbol('ws'), ws.descriptor);
    await Promise.resolve();

    expect(ws.sent[0]).toEqual({
      event: '__acme:analytics:flushed',
      payload: { count: 1 },
    });
  });

  it('still applies sequence and dedup to module outgoing events', async () => {
    const Analytics = defineModule({
      id: 'acme:analytics',
      key: Symbol('acme:analytics'),
      outgoing: [outgoing('flushed', t<{ count: number }>())] as const,
      setup(_args, hooks) {
        hooks.onConnect(async (ctx) => {
          ctx.send('flushed', { count: 1 });
        });

        return () => ({});
      },
    });

    const handler = server('engine-module-outgoing-metadata', {
      _dedup: DedupPrimitive.dedup,
      _outgoing: outgoing,
      _sequence: SequencePrimitive.sequence,
    }).define(SequencePrimitive.sequence(), DedupPrimitive.dedup(), Analytics({}));

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    const ws = createDescriptor();
    engine.accept(Symbol('ws-module'), ws.descriptor);
    await Promise.resolve();

    expect(ws.sent[0]).toMatchObject({
      event: '__acme:analytics:flushed',
      payload: { count: 1, _seq: 1 },
    });
    expect(ws.sent[0]?.payload?._messageId).toMatch(/^msg_/);
  });

  it('rejects reserved engine fields added by module onOutgoing hooks', async () => {
    const Analytics = defineModule({
      id: 'acme:analytics',
      key: Symbol('acme:analytics'),
      setup(_args, hooks) {
        hooks.onOutgoing((message) => ({
          event: message.event,
          payload: {
            ...(message.payload as Record<string, unknown>),
            _channel: 'forged',
          },
        }));

        return () => ({});
      },
    });

    const handler = server('engine-module-reserved-fields', {
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
    }).define(
      Analytics({}),
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (ctx: { send(event: 'message', payload: { text: string }): boolean }, payload) => {
          ctx.send('message', payload);
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    const ws = createDescriptor();
    const conn = engine.accept(Symbol('ws-module-reserved'), ws.descriptor);
    conn.handleMessage(JSON.stringify({ event: 'echo', payload: { text: 'hello' } }));
    await flushAsyncWork();
    await flushAsyncWork();

    expect(ws.sent.at(-1)).toEqual({
      event: '_error',
      payload: { code: 'internal-error' },
    });
  });

  it('rejects non-object payloads on the normal outgoing pipeline', async () => {
    const handler = server('engine-payload-shape', {
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
    }).define(
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (ctx: { send(event: 'message', payload: unknown): boolean }) => {
          ctx.send('message', 'not-an-object');
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    const ws = createDescriptor();
    const conn = engine.accept(Symbol('ws-payload-shape'), ws.descriptor);
    conn.handleMessage(JSON.stringify({ event: 'echo', payload: { text: 'pong' } }));
    await flushAsyncWork();
    await flushAsyncWork();

    expect(ws.sent.at(-1)).toEqual({
      event: '_error',
      payload: { code: 'internal-error' },
    });
  });

  it('rejects non-object payloads on sendReplay', async () => {
    const handler = server('engine-replay-payload-shape', {
      _dedup: DedupPrimitive.dedup,
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
      _replay: ReplayPrimitive.replay,
      _sequence: SequencePrimitive.sequence,
    }).define(
      SequencePrimitive.sequence({ persist: true }),
      DedupPrimitive.dedup(),
      outgoing('message', t<{ text: string }>()),
      ReplayPrimitive.replay(),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (ctx: {
          sendReplay(
            event: 'message',
            payload: unknown,
            wire: { seq: number; messageId: string },
          ): void;
        }) => {
          expect(() =>
            ctx.sendReplay('message', 'not-an-object', {
              seq: 1,
              messageId: 'm1',
            }),
          ).toThrow('[wskit] Outgoing payload must be a plain object.');
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    const ws = createDescriptor();
    const conn = engine.accept(Symbol('ws-replay-shape'), ws.descriptor);
    conn.handleMessage(JSON.stringify({ event: 'echo', payload: { text: 'pong' } }));
    await flushAsyncWork();
  });

  it('tracks connection latency and quality from raw ping/pong frames', async () => {
    const metrics: Array<{ latency: number | null; quality: string }> = [];
    const scheduled: Array<() => void> = [];
    const sentRaw: string[] = [];

    const handler = server('engine-connection-metrics', {
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
    }).define(
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (
          ctx: {
            latency: number | null;
            quality: 'excellent' | 'good' | 'degraded' | 'poor';
            send(event: 'message', payload: { text: string }): boolean;
          },
          payload,
        ) => {
          metrics.push({ latency: ctx.latency, quality: ctx.quality });
          ctx.send('message', payload);
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    engine.setStorage(createStorage());
    engine.setTimerProvider({
      setTimeout(callback) {
        scheduled.push(callback);
        return scheduled.length - 1;
      },
      clearTimeout() {},
    });
    engine.setWaitUntil(() => {});
    await engine.initialize();

    const ws = {
      sent: [] as { event: string; payload?: Record<string, unknown> }[],
      descriptor: {
        send(data: string) {
          if (data === 'ping' || data === 'pong') {
            sentRaw.push(data);
            return;
          }

          ws.sent.push(JSON.parse(data) as { event: string; payload?: Record<string, unknown> });
        },
        sendBinary() {},
        close() {},
        bufferedAmount() {
          return 0;
        },
        meta: {},
        tags: [] as const,
      },
    };

    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);

    const conn = engine.accept(Symbol('ws-latency'), ws.descriptor);

    scheduled[0]!();
    expect(sentRaw).toEqual(['ping']);

    now.mockReturnValue(1_080);
    conn.handleMessage('pong');
    conn.handleMessage(JSON.stringify({ event: 'echo', payload: { text: 'hi' } }));
    await flushAsyncWork();

    expect(metrics).toEqual([{ latency: 80, quality: 'excellent' }]);
    expect(ws.sent).toEqual([{ event: 'message', payload: { text: 'hi' } }]);

    conn.handleMessage('ping');
    await flushAsyncWork();
    expect(sentRaw).toEqual(['ping', 'pong']);

    now.mockRestore();
  });

  it('dispatches top-level replay requests through the replay primitive', async () => {
    const handler = server('engine-replay-top-level', {
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
      _replay: ReplayPrimitive.replay,
      _sequence: SequencePrimitive.sequence,
      _dedup: DedupPrimitive.dedup,
    }).define(
      SequencePrimitive.sequence({ persist: true }),
      DedupPrimitive.dedup(),
      outgoing('message', t<{ text: string }>()),
      ReplayPrimitive.replay(),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (ctx: { send(event: 'message', payload: { text: string }): void }, payload) => {
          ctx.send('message', { text: payload.text });
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    const storage = createStorage();

    attachTestAdapter(engine, storage);
    await engine.initialize();

    const ws = createDescriptor();
    const conn = engine.accept(Symbol('ws-replay-top-level'), ws.descriptor);
    conn.handleMessage(JSON.stringify({ event: 'echo', payload: { text: 'history' } }));
    await flushAsyncWork();
    conn.handleMessage(JSON.stringify({ event: '_replay', payload: { since: 0 } }));
    await flushAsyncWork();

    expect(storage.sql.replay.size).toBe(1);
    expect(ws.sent[0]).toEqual({
      event: 'message',
      payload: {
        text: 'history',
        _seq: expect.any(Number),
        _messageId: expect.any(String),
      },
    });
    expect(ws.sent[1]).toEqual(ws.sent[0]);
    expect((ws.sent[0]?.payload?._seq as number) > 0).toBe(true);
  });

  it('stores replay rows before sending when durability is strict', async () => {
    let replayRowsBeforeSend = 0;

    const handler = server('engine-replay-strict', {
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
      _replay: ReplayPrimitive.replay,
      _sequence: SequencePrimitive.sequence,
      _dedup: DedupPrimitive.dedup,
    }).define(
      SequencePrimitive.sequence({ persist: true }),
      DedupPrimitive.dedup(),
      ReplayPrimitive.replay({ durability: 'strict' }),
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (
          ctx: {
            send(event: 'message', payload: { text: string }): void;
            sql: {
              exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] };
            };
          },
          payload,
        ) => {
          ctx.send('message', { text: payload.text });
          replayRowsBeforeSend = ctx.sql
            .exec(
              `
                SELECT
                  rowKey,
                  messageId,
                  seq,
                  event,
                  payload,
                  namespace,
                  channel,
                  channelScope,
                  snapshotKey,
                  createdAt
                FROM _wskit_replay
                WHERE namespace IS NULL
                  AND channel IS NULL
                  AND channelScope IS NULL
                  AND seq > ?
                ORDER BY seq ASC
              `,
              0,
            )
            .toArray().length;
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });
    const storage = createStorage();

    attachTestAdapter(engine, storage);
    await engine.initialize();

    const ws = createDescriptor();
    const conn = engine.accept(Symbol('ws-replay-strict'), ws.descriptor);
    conn.handleMessage(JSON.stringify({ event: 'echo', payload: { text: 'pong' } }));
    await flushAsyncWork();

    expect(replayRowsBeforeSend).toBe(1);
  });

  it('stores replay rows after sending when durability is best-effort', async () => {
    let replayRowsBeforeSend = 0;

    const handler = server('engine-replay-best-effort', {
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
      _replay: ReplayPrimitive.replay,
      _sequence: SequencePrimitive.sequence,
      _dedup: DedupPrimitive.dedup,
    }).define(
      SequencePrimitive.sequence({ persist: true }),
      DedupPrimitive.dedup(),
      ReplayPrimitive.replay({ durability: 'best-effort' }),
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (
          ctx: {
            send(event: 'message', payload: { text: string }): void;
            sql: {
              exec(query: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] };
            };
          },
          payload,
        ) => {
          ctx.send('message', { text: payload.text });
          replayRowsBeforeSend = ctx.sql
            .exec(
              `
                SELECT
                  rowKey,
                  messageId,
                  seq,
                  event,
                  payload,
                  namespace,
                  channel,
                  channelScope,
                  snapshotKey,
                  createdAt
                FROM _wskit_replay
                WHERE namespace IS NULL
                  AND channel IS NULL
                  AND channelScope IS NULL
                  AND seq > ?
                ORDER BY seq ASC
              `,
              0,
            )
            .toArray().length;
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });
    const storage = createStorage();

    attachTestAdapter(engine, storage);
    await engine.initialize();

    const ws = createDescriptor();
    const conn = engine.accept(Symbol('ws-replay-best-effort'), ws.descriptor);
    conn.handleMessage(JSON.stringify({ event: 'echo', payload: { text: 'pong' } }));
    await flushAsyncWork();
    await flushAsyncWork();

    expect(replayRowsBeforeSend).toBe(0);
    expect(storage.sql.replay.size).toBe(1);
  });

  it('fails boot when the adapter does not provide waitUntil', async () => {
    const handler = server('engine-replay-best-effort-needs-waituntil', {
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
      _replay: ReplayPrimitive.replay,
      _sequence: SequencePrimitive.sequence,
      _dedup: DedupPrimitive.dedup,
    }).define(
      SequencePrimitive.sequence({ persist: true }),
      DedupPrimitive.dedup(),
      ReplayPrimitive.replay({ durability: 'best-effort' }),
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async () => {},
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    engine.setStorage(createStorage());
    engine.setTimerProvider(createTimers().timers);

    await expect(engine.initialize()).rejects.toThrow('did not provide waitUntil');
  });

  it('fails boot when replay is registered without persistent sequence', async () => {
    const handler = server('engine-replay-needs-persistent-sequence', {
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
      _replay: ReplayPrimitive.replay,
      _sequence: SequencePrimitive.sequence,
      _dedup: DedupPrimitive.dedup,
    }).define(
      SequencePrimitive.sequence(),
      DedupPrimitive.dedup(),
      ReplayPrimitive.replay(),
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async () => {},
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(engine);

    await expect(engine.initialize()).rejects.toThrow(
      'replay() requires sequence({ persist: true })',
    );
  });

  it('keeps sequence numbers increasing across engine restarts when persistence is enabled', async () => {
    const handler = server('engine-sequence-persistent', {
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
      _sequence: SequencePrimitive.sequence,
    }).define(
      SequencePrimitive.sequence({ persist: true }),
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (ctx: { send(event: 'message', payload: { text: string }): void }, payload) => {
          ctx.send('message', { text: payload.text });
        },
      ),
    );

    const storage = createStorage();

    const firstEngine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(firstEngine, storage);
    await firstEngine.initialize();

    const firstWs = createDescriptor();
    const firstConn = firstEngine.accept(Symbol('ws-seq-first'), firstWs.descriptor);
    firstConn.handleMessage(JSON.stringify({ event: 'echo', payload: { text: 'one' } }));
    await flushAsyncWork();

    const secondEngine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(secondEngine, storage);
    await secondEngine.initialize();

    const secondWs = createDescriptor();
    const secondConn = secondEngine.accept(Symbol('ws-seq-second'), secondWs.descriptor);
    secondConn.handleMessage(JSON.stringify({ event: 'echo', payload: { text: 'two' } }));
    await flushAsyncWork();

    expect(firstWs.sent[0]).toEqual({
      event: 'message',
      payload: { text: 'one', _seq: 1 },
    });
    expect(secondWs.sent[0]).toEqual({
      event: 'message',
      payload: { text: 'two', _seq: 2 },
    });
  });

  it('prunes expired replay rows on write', async () => {
    const now = Date.now();

    const handler = server('engine-replay-prune', {
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
      _replay: ReplayPrimitive.replay,
      _sequence: SequencePrimitive.sequence,
      _dedup: DedupPrimitive.dedup,
    }).define(
      SequencePrimitive.sequence({ persist: true }),
      DedupPrimitive.dedup(),
      ReplayPrimitive.replay({ retention: { maxAgeMs: 1_000 } }),
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (ctx: { send(event: 'message', payload: { text: string }): void }, payload) => {
          ctx.send('message', { text: payload.text });
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });
    const storage = createStorage();

    storage.sql.replay.set('old', {
      rowKey: 'old',
      messageId: 'old',
      seq: 1,
      event: 'message',
      payload: JSON.stringify({ text: 'old', _seq: 1, _messageId: 'old' }),
      namespace: null,
      channel: null,
      channelScope: null,
      snapshotKey: null,
      createdAt: now - 10_000,
    });

    attachTestAdapter(engine, storage);
    await engine.initialize();

    const realNow = Date.now;
    Date.now = () => now;

    const ws = createDescriptor();
    const conn = engine.accept(Symbol('ws-replay-prune'), ws.descriptor);
    conn.handleMessage(JSON.stringify({ event: 'echo', payload: { text: 'fresh' } }));
    await flushAsyncWork();

    Date.now = realNow;

    expect([...storage.sql.replay.values()].every((row) => row.messageId !== 'old')).toBe(true);
  });

  it('dispatches channel replay requests through the matching channel replay primitive', async () => {
    const handler = server('engine-replay-channel', {
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
      _replay: ReplayPrimitive.replay,
      _sequence: SequencePrimitive.sequence,
      _dedup: DedupPrimitive.dedup,
      _channel: ChannelPrimitive.channel,
    }).define(
      SequencePrimitive.sequence({ persist: true }),
      DedupPrimitive.dedup(),
      ChannelPrimitive.channel(
        ChannelPrimitive.scope('rooms', /^room-/),
        ReplayPrimitive.replay(),
        outgoing('message', t<{ text: string }>()),
        IncomingPrimitive.incoming(
          received('echo', (value: unknown) => value as { text: string }),
          async (
            ctx: {
              channel: {
                send(event: 'message', payload: { text: string }): boolean;
              };
            },
            payload,
          ) => {
            ctx.channel.send('message', { text: payload.text });
          },
        ),
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });
    const storage = createStorage();

    attachTestAdapter(engine, storage);
    await engine.initialize();

    const ws = createDescriptor();
    const conn = engine.accept(Symbol('ws-replay-channel'), ws.descriptor);
    conn.handleMessage(
      JSON.stringify({
        event: '_subscribe',
        payload: { _channel: 'room-1', _channelScope: 'rooms' },
      }),
    );
    await flushAsyncWork();
    conn.handleMessage(
      JSON.stringify({
        event: 'echo',
        payload: { text: 'room-history', _channel: 'room-1', _channelScope: 'rooms' },
      }),
    );
    await flushAsyncWork();
    conn.handleMessage(
      JSON.stringify({
        event: '_replay',
        payload: { since: 0, _channel: 'room-1', _channelScope: 'rooms' },
      }),
    );
    await flushAsyncWork();

    expect(ws.sent[2]).toEqual({
      event: 'message',
      payload: {
        text: 'room-history',
        _seq: expect.any(Number),
        _messageId: expect.any(String),
        _channel: 'room-1',
        _channelScope: 'rooms',
      },
    });
    expect(ws.sent[2]).toEqual(ws.sent[1]);
  });

  it('registers built-in lifecycle hooks through primitive setup', async () => {
    const events: string[] = [];
    const s = server('engine-lifecycle', {
      _incoming: IncomingPrimitive.incoming,
      _onBinary: onBinary,
      _onConnect: onConnect,
      _onDisconnect: onDisconnect,
      _onError: onError,
      _onInit: onInit,
      _onShutdown: onShutdown,
      _onUpgrade: onUpgrade,
      _onValidationError: onValidationError,
      _outgoing: outgoing,
    });

    const handler = s.define(
      onInit(async () => {
        events.push('init');
      }),
      onConnect(async () => {
        events.push('connect');
      }),
      onDisconnect(async () => {
        events.push('disconnect');
      }),
      onShutdown(async () => {
        events.push('shutdown');
      }),
      onUpgrade(async () => {
        events.push('upgrade');
        return { meta: { role: 'member' }, tags: ['ready'] };
      }),
      onBinary(async (_ctx, data) => {
        events.push(`binary:${data.byteLength}`);
      }),
      onValidationError(async (_ctx, event) => {
        events.push(`invalid:${event}`);
      }),
      onError(async (_ctx, error, event) => {
        events.push(`error:${event}:${error instanceof WskitError ? error.code : 'internal'}`);
      }),
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (ctx: { send(event: 'message', payload: { text: string }): boolean }, payload) => {
          ctx.send('message', payload);
        },
      ),
      IncomingPrimitive.incoming(
        received('bad', (_value: unknown): { text: string } => {
          throw new Error('bad payload');
        }),
        async () => {},
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    expect(events).toContain('init');

    const upgrade = await engine.handleUpgrade(new Request('https://example.com/ws'));
    expect(upgrade.meta).toEqual({ role: 'member' });
    expect(upgrade.tags).toEqual(['ready']);

    const socket = createDescriptor();
    const conn = engine.accept(Symbol('ws-lifecycle'), socket.descriptor);
    await flushAsyncWork();

    conn.handleBinary(new Uint8Array([1, 2, 3]).buffer);
    await flushAsyncWork();

    conn.handleMessage(JSON.stringify({ event: 'bad', payload: {} }));
    await flushAsyncWork();
    await flushAsyncWork();

    conn.handleClose(1000, 'done');
    await flushAsyncWork();

    await engine.handleShutdown();

    expect(events).toEqual(
      expect.arrayContaining([
        'init',
        'upgrade',
        'connect',
        'binary:3',
        'invalid:bad',
        'error:bad:internal',
        'disconnect',
        'shutdown',
      ]),
    );
    expect(socket.sent.some((entry) => entry.event === '_error')).toBe(true);
  });

  it('runs channel subscribe lifecycle and membership protocol', async () => {
    const roomEvents: string[] = [];
    const s = server('engine-channels', {
      _channel: ChannelPrimitive.channel,
      _incoming: IncomingPrimitive.incoming,
      _onBeforeSubscribe: onBeforeSubscribe,
      _onSubscribe: onSubscribe,
      _onUnsubscribe: onUnsubscribe,
      _outgoing: outgoing,
    });

    const handler = s.define(
      ChannelPrimitive.channel(
        ChannelPrimitive.scope('rooms', /^room-/),
        outgoing('room-event', t<{ text: string }>()),
        onBeforeSubscribe(async () => {
          roomEvents.push('before');
        }),
        onSubscribe(async () => {
          roomEvents.push('subscribe');
        }),
        onUnsubscribe(async () => {
          roomEvents.push('unsubscribe');
        }),
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    const first = createDescriptor({ userId: 'a' });
    const second = createDescriptor({ userId: 'b' });

    const firstConn = engine.accept(Symbol('ws1'), first.descriptor);
    const secondConn = engine.accept(Symbol('ws2'), second.descriptor);

    firstConn.handleMessage(
      JSON.stringify({
        event: '_subscribe',
        payload: { _channel: 'room-general', _channelScope: 'rooms' },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    secondConn.handleMessage(
      JSON.stringify({
        event: '_subscribe',
        payload: { _channel: 'room-general', _channelScope: 'rooms' },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(roomEvents).toEqual(['before', 'subscribe', 'before', 'subscribe']);
    expect(first.sent.some((entry) => entry.event === '_subscribeOk')).toBe(true);
    expect(second.sent.some((entry) => entry.event === '_subscribeOk')).toBe(true);
    expect(
      second.sent.some(
        (entry) =>
          entry.event === '_memberJoin' &&
          (entry.payload?.meta as { userId?: string } | undefined)?.userId === 'a',
      ),
    ).toBe(true);
    expect(
      first.sent.some(
        (entry) =>
          entry.event === '_memberJoin' &&
          (entry.payload?.meta as { userId?: string } | undefined)?.userId === 'b',
      ),
    ).toBe(true);

    secondConn.handleMessage(
      JSON.stringify({
        event: '_unsubscribe',
        payload: { _channel: 'room-general', _channelScope: 'rooms' },
      }),
    );
    await Promise.resolve();

    expect(roomEvents.at(-1)).toBe('unsubscribe');
    expect(first.sent.some((entry) => entry.event === '_memberLeave')).toBe(true);
  });

  it('restores connection identity from hibernation attachment', async () => {
    const handler = server('engine-hibernation', {
      _ack: AckPrimitive.ack,
      _hibernation: HibernationPrimitive.hibernation,
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
    }).define(
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (ctx, payload) => {
          ctx.send('message', payload);
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: true,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    let attachment: unknown = {
      id: 'conn_saved',
      meta: { userId: 'saved' },
      tags: ['member'],
      channels: ['room-general'],
    };

    const wsLike = {
      send() {},
      close() {},
      serializeAttachment(value: unknown) {
        attachment = value;
      },
      deserializeAttachment() {
        return attachment;
      },
    };

    const conn = engine.handleHibernationWake(wsLike);
    conn.handleMessage(JSON.stringify({ event: 'echo', payload: { text: 'hi' } }));
    await Promise.resolve();

    expect((attachment as { id: string }).id).toBe('conn_saved');
  });

  it('rejects hibernation wake when the handler did not enable hibernation', async () => {
    const handler = server('engine-no-hibernation', {
      _incoming: IncomingPrimitive.incoming,
      _outgoing: outgoing,
    }).define(
      outgoing('message', t<{ text: string }>()),
      IncomingPrimitive.incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (ctx, payload) => {
          ctx.send('message', payload);
        },
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: true,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    expect(engine.usesHibernation()).toBe(false);
    expect(() => engine.handleHibernationWake({})).toThrow(
      '[wskit] hibernation() is not enabled for this handler.',
    );
  });

  it('buffers stream nudges and delivers _streamId on stream errors', async () => {
    let releaseFirstYield!: () => void;
    const firstYieldReady = new Promise<void>((resolve) => {
      releaseFirstYield = resolve;
    });
    const askAi = StreamPrimitive.stream(
      StreamPrimitive.start('ask-ai', (value: unknown) => value as { prompt: string }),
      StreamPrimitive.chunks(t<{ text: string }>()),
      StreamPrimitive.nudge('add-context', (value: unknown) => value as { text: string }),
    );

    const handler = server('engine-streams', {
      _stream: StreamPrimitive.stream,
      _outgoing: outgoing,
    }).define(
      StreamPrimitive.generate(askAi, async function* (ctx, payload) {
        await firstYieldReady;
        const nudges = ctx.nudges(yield { text: payload.prompt });
        throw new WskitError('stream-failed', {
          count: nudges.length,
          text: (nudges[0]?.payload as { text: string } | undefined)?.text ?? 'missing',
        });
      }),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    const socket = createDescriptor();
    const conn = engine.accept(Symbol('ws-stream'), socket.descriptor);
    conn.handleMessage(JSON.stringify({ event: 'ask-ai', payload: { prompt: 'hello' } }));
    await flushAsyncWork();

    const streamOk = socket.sent.find((entry) => entry.event === '_streamOk');
    expect(streamOk?.payload?._streamId).toBeTypeOf('string');

    conn.handleMessage(
      JSON.stringify({
        event: 'add-context',
        payload: {
          _streamId: streamOk?.payload?._streamId,
          text: 'more',
        },
      }),
    );
    releaseFirstYield();
    await flushAsyncWork();
    await flushAsyncWork();

    expect(socket.sent.some((entry) => entry.event === 'ask-ai')).toBe(true);
    expect(
      socket.sent.some(
        (entry) =>
          entry.event === '_error' &&
          entry.payload?._streamId === streamOk?.payload?._streamId &&
          entry.payload?.code === 'stream-failed' &&
          (entry.payload?.detail as { count?: number } | undefined)?.count === 1,
      ),
    ).toBe(true);
  });

  it('cancels active streams with _streamCancel', async () => {
    let released = false;
    let releasePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    const askAi = StreamPrimitive.stream(
      StreamPrimitive.start('ask-ai', (value: unknown) => value as { prompt: string }),
      StreamPrimitive.chunks(t<{ text: string }>()),
      StreamPrimitive.nudge('cancel'),
    );

    const handler = server('engine-stream-cancel', {
      _stream: StreamPrimitive.stream,
      _outgoing: outgoing,
    }).define(
      StreamPrimitive.generate(askAi, async function* (ctx, payload) {
        try {
          ctx.nudges(yield { text: payload.prompt });
          await pending;
        } finally {
          released = true;
        }
      }),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    attachTestAdapter(engine);
    await engine.initialize();

    const socket = createDescriptor();
    const conn = engine.accept(Symbol('ws-cancel'), socket.descriptor);
    conn.handleMessage(JSON.stringify({ event: 'ask-ai', payload: { prompt: 'hello' } }));
    await flushAsyncWork();

    const streamOk = socket.sent.find((entry) => entry.event === '_streamOk');
    conn.handleMessage(
      JSON.stringify({
        event: '_streamCancel',
        payload: { _streamId: streamOk?.payload?._streamId },
      }),
    );
    releasePending();
    await flushAsyncWork();
    await flushAsyncWork();

    expect(released).toBe(true);
    expect(socket.sent.some((entry) => entry.event === '_streamEnd')).toBe(false);
  });
});
