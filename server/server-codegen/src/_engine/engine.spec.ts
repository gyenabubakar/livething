import { WskitError } from '@wskit/core';
import { ack } from '~/ack/index.ts';
import { channel, scope } from '~/channel/index.ts';
import { dedup } from '~/dedup/index.ts';
import { hibernation } from '~/hibernation/index.ts';
import { incoming } from '~/incoming/index.ts';
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
import { replay } from '~/replay/index.ts';
import { sequence } from '~/sequence/index.ts';
import { chunks, generate, nudge, start, stream } from '~/stream/index.ts';
import { describe, expect, it } from 'vitest';
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

    if (normalizedQuery.startsWith('DELETE FROM _wskit_scheduled_dlq')) {
      this.scheduledDlq.clear();
      return new FakeSqlResult([]);
    }

    if (normalizedQuery.startsWith('DELETE FROM _wskit_scheduled')) {
      this.scheduled.clear();
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
      for (const callback of callbacks.values()) {
        callback();
      }
      callbacks.clear();
    },
  };
}

function createDescriptor(meta: Record<string, unknown> = {}) {
  const sent: { event: string; payload?: Record<string, unknown> }[] = [];
  const closed: { code?: number; reason?: string }[] = [];

  return {
    sent,
    closed,
    descriptor: {
      send(data: string) {
        sent.push(JSON.parse(data) as { event: string; payload?: Record<string, unknown> });
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
      _ack: ack,
      _incoming: incoming,
      _outgoing: outgoing,
      _sequence: sequence,
    }).define(
      sequence(),
      outgoing('message', t<{ text: string }>()),
      incoming(
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

    engine.setStorage(createStorage());
    engine.setTimerProvider(createTimers().timers);
    await engine.initialize();

    const ws = createDescriptor();
    const connection = engine.accept(Symbol('ws'), ws.descriptor);
    connection.handleMessage(
      JSON.stringify({
        event: 'echo',
        payload: { text: 'pong', _ackId: 'ack-1' },
      }),
    );
    await Promise.resolve();

    expect(ws.sent).toEqual([
      { event: '_ack', payload: { _ackId: 'ack-1' } },
      { event: 'message', payload: { text: 'pong', _seq: 1 } },
      { event: 'message', payload: { text: 'pong!', _seq: 2 } },
    ]);
  });

  it('lets dedup own _messageId injection while skipping protocol events', async () => {
    const ping = received('echo', (value: unknown) => value as { text: string });

    const handler = server('engine-dedup', {
      _ack: ack,
      _dedup: dedup,
      _incoming: incoming,
      _outgoing: outgoing,
    }).define(
      dedup(),
      outgoing('message', t<{ text: string }>()),
      incoming(
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

    engine.setStorage(createStorage());
    engine.setTimerProvider(createTimers().timers);
    await engine.initialize();

    const ws = createDescriptor();
    const connection = engine.accept(Symbol('ws-dedup'), ws.descriptor);
    connection.handleMessage(
      JSON.stringify({
        event: 'echo',
        payload: { text: 'pong', _ackId: 'ack-1' },
      }),
    );
    await Promise.resolve();

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
      _incoming: incoming,
      _scheduled: scheduled,
    }).define(
      flushTask,
      incoming(
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
    await engine.initialize();

    const { descriptor } = createDescriptor();
    const conn = engine.accept(Symbol('ws'), descriptor);
    conn.handleMessage(JSON.stringify({ event: 'queue-task', payload: { force: true } }));
    await Promise.resolve();

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

    engine.setStorage(createStorage());
    engine.setTimerProvider(createTimers().timers);
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
      _dedup: dedup,
      _outgoing: outgoing,
      _sequence: sequence,
    }).define(sequence(), dedup(), Analytics({}));

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    engine.setStorage(createStorage());
    engine.setTimerProvider(createTimers().timers);
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

  it('rejects non-object payloads on the normal outgoing pipeline', async () => {
    const handler = server('engine-payload-shape', {
      _incoming: incoming,
      _outgoing: outgoing,
    }).define(
      outgoing('message', t<{ text: string }>()),
      incoming(
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

    engine.setStorage(createStorage());
    engine.setTimerProvider(createTimers().timers);
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
      _dedup: dedup,
      _incoming: incoming,
      _outgoing: outgoing,
      _replay: replay,
      _sequence: sequence,
    }).define(
      sequence(),
      dedup(),
      outgoing('message', t<{ text: string }>()),
      replay({
        async onReplay(ctx: {
          sendReplay(
            event: 'message',
            payload: unknown,
            wire: { seq: number; messageId: string },
          ): void;
        }) {
          expect(() =>
            ctx.sendReplay('message', 'not-an-object', {
              seq: 1,
              messageId: 'm1',
            }),
          ).toThrow('[wskit] Outgoing payload must be a plain object.');
        },
      }),
      incoming(
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
    await engine.initialize();

    const ws = createDescriptor();
    const conn = engine.accept(Symbol('ws-replay-shape'), ws.descriptor);
    conn.handleMessage(JSON.stringify({ event: '_replay', payload: { since: 0 } }));
    await flushAsyncWork();
  });

  it('dispatches top-level replay requests through the replay primitive', async () => {
    const seen: number[] = [];

    const handler = server('engine-replay-top-level', {
      _incoming: incoming,
      _outgoing: outgoing,
      _replay: replay,
      _sequence: sequence,
      _dedup: dedup,
    }).define(
      sequence(),
      dedup(),
      outgoing('message', t<{ text: string }>()),
      replay({
        async onReplay(
          ctx: {
            sendReplay(
              event: 'message',
              payload: { text: string },
              wire: { seq: number; messageId: string },
            ): void;
          },
          since,
        ) {
          seen.push(since);
          ctx.sendReplay('message', { text: 'history' }, { seq: 7, messageId: 'm7' });
        },
      }),
      incoming(
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
    await engine.initialize();

    const ws = createDescriptor();
    const conn = engine.accept(Symbol('ws-replay-top-level'), ws.descriptor);
    conn.handleMessage(JSON.stringify({ event: '_replay', payload: { since: 4 } }));
    await flushAsyncWork();

    expect(seen).toEqual([4]);
    expect(ws.sent[0]).toEqual({
      event: 'message',
      payload: { text: 'history', _seq: 7, _messageId: 'm7' },
    });
  });

  it('dispatches channel replay requests through the matching channel replay primitive', async () => {
    const seen: number[] = [];

    const handler = server('engine-replay-channel', {
      _incoming: incoming,
      _outgoing: outgoing,
      _replay: replay,
      _sequence: sequence,
      _dedup: dedup,
      _channel: channel,
    }).define(
      sequence(),
      dedup(),
      channel(
        scope('rooms', /^room-/),
        replay({
          async onReplay(
            ctx: {
              channel: {
                sendReplay(
                  event: 'message',
                  payload: { text: string },
                  wire: { seq: number; messageId: string },
                ): void;
              };
            },
            since,
          ) {
            seen.push(since);
            ctx.channel.sendReplay(
              'message',
              { text: 'room-history' },
              { seq: 9, messageId: 'm9' },
            );
          },
        }),
        outgoing('message', t<{ text: string }>()),
        incoming(
          received('echo', (value: unknown) => value as { text: string }),
          async () => {},
        ),
      ),
    );

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: false,
    });

    engine.setStorage(createStorage());
    engine.setTimerProvider(createTimers().timers);
    await engine.initialize();

    const ws = createDescriptor();
    const conn = engine.accept(Symbol('ws-replay-channel'), ws.descriptor);
    conn.handleMessage(
      JSON.stringify({
        event: '_replay',
        payload: { since: 3, _channel: 'room-1', _channelScope: 'rooms' },
      }),
    );
    await flushAsyncWork();

    expect(seen).toEqual([3]);
    expect(ws.sent[0]).toEqual({
      event: 'message',
      payload: {
        text: 'room-history',
        _seq: 9,
        _messageId: 'm9',
        _channel: 'room-1',
        _channelScope: 'rooms',
      },
    });
  });

  it('registers built-in lifecycle hooks through primitive setup', async () => {
    const events: string[] = [];
    const s = server('engine-lifecycle', {
      _incoming: incoming,
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
        return false;
      }),
      outgoing('message', t<{ text: string }>()),
      incoming(
        received('echo', (value: unknown) => value as { text: string }),
        async (ctx: { send(event: 'message', payload: { text: string }): boolean }, payload) => {
          ctx.send('message', payload);
        },
      ),
      incoming(
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

    engine.setStorage(createStorage());
    engine.setTimerProvider(createTimers().timers);
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
    expect(socket.sent.some((entry) => entry.event === '_error')).toBe(false);
  });

  it('runs channel subscribe lifecycle and membership protocol', async () => {
    const roomEvents: string[] = [];
    const s = server('engine-channels', {
      _channel: channel,
      _incoming: incoming,
      _onBeforeSubscribe: onBeforeSubscribe,
      _onSubscribe: onSubscribe,
      _onUnsubscribe: onUnsubscribe,
      _outgoing: outgoing,
    });

    const handler = s.define(
      channel(
        scope('rooms', /^room-/),
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

    engine.setStorage(createStorage());
    engine.setTimerProvider(createTimers().timers);
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
      _ack: ack,
      _hibernation: hibernation,
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

    const engine = new Engine(handler, {
      adapterId: 'test',
      hibernation: true,
    });

    engine.setStorage(createStorage());
    engine.setTimerProvider(createTimers().timers);
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

  it('buffers stream nudges and delivers _streamId on stream errors', async () => {
    let releaseFirstYield!: () => void;
    const firstYieldReady = new Promise<void>((resolve) => {
      releaseFirstYield = resolve;
    });
    const askAi = stream(
      start('ask-ai', (value: unknown) => value as { prompt: string }),
      chunks(t<{ text: string }>()),
      nudge('add-context', (value: unknown) => value as { text: string }),
    );

    const handler = server('engine-streams', {
      _stream: stream,
      _outgoing: outgoing,
    }).define(
      generate(askAi, async function* (ctx, payload) {
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

    engine.setStorage(createStorage());
    engine.setTimerProvider(createTimers().timers);
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
    const askAi = stream(
      start('ask-ai', (value: unknown) => value as { prompt: string }),
      chunks(t<{ text: string }>()),
      nudge('cancel'),
    );

    const handler = server('engine-stream-cancel', {
      _stream: stream,
      _outgoing: outgoing,
    }).define(
      generate(askAi, async function* (ctx, payload) {
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

    engine.setStorage(createStorage());
    engine.setTimerProvider(createTimers().timers);
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
