import { WskitError } from '@wskit/core';
import { describe, expect, it } from 'vitest';
import { ack } from '../ack/index.ts';
import { channel, scope } from '../channel/index.ts';
import { hibernation } from '../hibernation/index.ts';
import { incoming } from '../incoming/index.ts';
import {
  defineModule,
  onBeforeSubscribe,
  onSubscribe,
  onUnsubscribe,
  outgoing,
  received,
  scheduled,
  server,
  t,
} from '../index.ts';
import { chunks, generate, nudge, start, stream } from '../stream/index.ts';
import { Engine } from './engine.ts';

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
    }
  >();

  exec(query: string, ...params: unknown[]) {
    if (query.startsWith('CREATE TABLE IF NOT EXISTS _wskit_scheduled')) {
      return new FakeSqlResult([]);
    }

    if (query.startsWith('SELECT id, taskId, time, data, everyMs FROM _wskit_scheduled')) {
      return new FakeSqlResult([...this.scheduled.values()]);
    }

    if (query.startsWith('DELETE FROM _wskit_scheduled')) {
      this.scheduled.clear();
      return new FakeSqlResult([]);
    }

    if (query.startsWith('INSERT INTO _wskit_scheduled')) {
      this.scheduled.set(String(params[0]), {
        id: String(params[0]),
        taskId: String(params[1]),
        time: Number(params[2]),
        data: (params[3] as string | null) ?? null,
        everyMs: (params[4] as number | null) ?? null,
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

    expect(storage.sql.scheduled.size).toBe(1);

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
