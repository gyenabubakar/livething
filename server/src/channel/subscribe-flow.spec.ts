import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { purgeUser } from '~/_engine/runtime/purge-user.ts';
import { MAX_PENDING_CONNECTION_WORK } from '~/_engine/runtime/work-queue.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { hasChannelMembership } from '~/channel/runtime.ts';
import { listMembershipsByUser } from '~/channel/storage.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { rateLimit } from '~/rate-limit/capability.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ConnectionRef, SQLProvider } from '~/context.ts';

const inRoom = { channel: { name: 'room' } };
const subscribeFrame = JSON.stringify(['__subscribe__', {}, inRoom]);
const sayFrame = JSON.stringify(['say', {}, inRoom]);
const unsubscribeFrame = JSON.stringify([
  '__unsubscribe__',
  null,
  { channel: { name: 'room', unsubscribeId: 'leave-1' } },
]);

function deferred() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function startEngine(
  definition: Parameters<ReturnType<typeof adapter>>[0],
): Promise<{ engine: Engine; sql: SQLProvider }> {
  const sql = createTestSql();
  let engine!: Engine;
  adapter({
    id: 'subscribe-flow-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql, kv: createTestKV() },
        timers: createTestTimers(),
        platform: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return {};
    },
  })(definition, undefined as never);
  await engine.initialize();

  return { engine, sql };
}

async function connect(engine: Engine, userId = 'ama') {
  const sent: unknown[][] = [];
  const handle = engine.accept(Symbol(userId), {
    send: (data: string) => sent.push(JSON.parse(data) as unknown[]),
    close: () => {},
    bufferedAmount: () => 0,
    userId,
  });
  const connection = [...engine.core.connections.values()].at(-1)!;
  await connection.lifecycleReady;

  return {
    handle,
    sent,
    connection,
    events: () => sent.map((frame) => frame[0]),
  };
}

describe('an unsubscribe sent while the check is pending', () => {
  function gatedRoom(gate: Promise<void>) {
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {
      async check() {
        await gate;
      },
    });
    return base.assemble({ handlers: [room] });
  }

  it('is confirmed before the check settles', async () => {
    const { gate, open } = deferred();
    const { engine } = await startEngine(gatedRoom(gate));
    const { handle, events } = await connect(engine);

    const subscribing = handle.handleMessage(subscribeFrame);
    const leaving = handle.handleMessage(unsubscribeFrame);

    try {
      await vi.waitFor(() => expect(events()).toContain('__unsubscribeOk__'));
    } finally {
      open();
      await Promise.all([subscribing, leaving]);
    }
  });

  it('abandons the subscribe, even when the check resolves later', async () => {
    const { gate, open } = deferred();
    const { engine } = await startEngine(gatedRoom(gate));
    const { handle, events, connection } = await connect(engine);

    const subscribing = handle.handleMessage(subscribeFrame);
    const leaving = handle.handleMessage(unsubscribeFrame);
    open();
    await Promise.all([subscribing, leaving]);

    expect(events()).not.toContain('__subscribeOk__');
    expect(hasChannelMembership(connection, 'room', null)).toBe(false);
  });
});

describe('a subscribe replaced by a later one', () => {
  it('reports no error when its check rejects later', async () => {
    const { gate, open } = deferred();
    let checks = 0;
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {
      async check() {
        checks += 1;
        if (checks === 1) {
          await gate;
          throw new Error('stale');
        }
      },
    });
    const { engine } = await startEngine(base.assemble({ handlers: [room] }));

    const { handle, events, connection } = await connect(engine);

    const first = handle.handleMessage(subscribeFrame);
    const second = handle.handleMessage(subscribeFrame);
    await macrotask();
    open();
    await Promise.all([first, second]);

    expect(events().filter((event) => event === '__subscribeOk__')).toHaveLength(1);
    expect(events()).not.toContain('__error__');
    expect(hasChannelMembership(connection, 'room', null)).toBe(true);
  });
});

describe('subscribe, unsubscribe, subscribe with a slower first check', () => {
  it('ends with the connection a member, as the client was last told', async () => {
    const { gate, open } = deferred();
    let checks = 0;
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {
      async check() {
        checks += 1;
        if (checks === 1) await gate;
      },
    });
    const { engine } = await startEngine(base.assemble({ handlers: [room] }));

    const { handle, events, connection } = await connect(engine);

    const frames = [
      handle.handleMessage(subscribeFrame),
      handle.handleMessage(unsubscribeFrame),
      handle.handleMessage(subscribeFrame),
    ];
    await macrotask();
    open();
    await Promise.all(frames);

    const answers = events().filter(
      (event) => event === '__subscribeOk__' || event === '__unsubscribeOk__',
    );
    expect(answers.at(-1)).toBe('__subscribeOk__');
    expect(hasChannelMembership(connection, 'room', null)).toBe(true);
  });
});

describe('frames queued behind a pending subscribe', () => {
  function limitedRoom(
    gate: Promise<void>,
    said: string[],
    rule: { maxMessages?: number; maxBytes?: number } = { maxMessages: 5 },
  ) {
    const base = server({ capabilities: [channels(), rateLimit(rule)] });
    const room = base.channel('room', {
      async check() {
        await gate;
      },
    });
    const handleSay = room.on('say', {
      run(ctx) {
        said.push(ctx.user.id);
      },
    });
    return base.assemble({ handlers: [handleSay] });
  }

  it('hold at most the connection work limit, and run the handler within the rate limit', async () => {
    const { gate, open } = deferred();
    const said: string[] = [];
    const { engine } = await startEngine(limitedRoom(gate, said));
    const { handle } = await connect(engine);

    const subscribing = handle.handleMessage(subscribeFrame);
    let unsettled = 0;
    const frames = Array.from({ length: 2_000 }, () => {
      unsettled += 1;
      return handle.handleMessage(sayFrame).finally(() => {
        unsettled -= 1;
      });
    });
    await macrotask();
    const held = unsettled;

    open();
    await Promise.all([subscribing, ...frames]);

    expect(held).toBeLessThanOrEqual(MAX_PENDING_CONNECTION_WORK);
    expect(said.length).toBeLessThanOrEqual(5);
  });

  it('count against the rate limit when they arrive', async () => {
    const { gate, open } = deferred();
    const said: string[] = [];
    const { engine } = await startEngine(limitedRoom(gate, said));
    const { handle, sent } = await connect(engine);

    const subscribing = handle.handleMessage(subscribeFrame);
    const frames = Array.from({ length: 20 }, () => handle.handleMessage(sayFrame));
    await macrotask();
    const refused = sent.filter(
      (frame) =>
        frame[0] === '__error__' && (frame[1] as { code?: string }).code === 'rate-limited',
    ).length;

    open();
    await Promise.all([subscribing, ...frames]);

    expect(refused).toBe(15);
  });

  it('count their size against maxBytes when they arrive', async () => {
    const { gate, open } = deferred();
    const said: string[] = [];
    const rule = { maxMessages: 100, maxBytes: sayFrame.length * 3 };
    const { engine } = await startEngine(limitedRoom(gate, said, rule));
    const { handle, sent } = await connect(engine);

    const subscribing = handle.handleMessage(subscribeFrame);
    const frames = Array.from({ length: 20 }, () => handle.handleMessage(sayFrame));
    await macrotask();
    const refused = sent.filter(
      (frame) =>
        frame[0] === '__error__' && (frame[1] as { code?: string }).code === 'rate-limited',
    ).length;

    open();
    await Promise.all([subscribing, ...frames]);

    expect(refused).toBe(17);
    expect(said).toHaveLength(3);
  });

  it('are refused with ConnectionBusy past the limit when no rate limit applies', async () => {
    const { gate, open } = deferred();
    const said: string[] = [];
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {
      async check() {
        await gate;
      },
    });
    const handleSay = room.on('say', {
      run(ctx) {
        said.push(ctx.user.id);
      },
    });

    const { engine } = await startEngine(base.assemble({ handlers: [handleSay] }));
    const { handle, sent } = await connect(engine);

    const subscribing = handle.handleMessage(subscribeFrame);
    const overLimit = 44;
    const frames = Array.from({ length: MAX_PENDING_CONNECTION_WORK + overLimit }, () =>
      handle.handleMessage(sayFrame),
    );
    await macrotask();
    const busy = sent.filter(
      (frame) =>
        frame[0] === '__error__' && (frame[1] as { code?: string }).code === 'connection-busy',
    );

    open();
    await Promise.all([subscribing, ...frames]);

    expect(busy).toHaveLength(overLimit);
    expect(said).toHaveLength(MAX_PENDING_CONNECTION_WORK);
  });
});

describe('purgeUser and a live connection', () => {
  it('leaves no durable membership row when a subscribe was waiting in check', async () => {
    const { gate, open } = deferred();
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {
      membership: 'persistent',
      async check() {
        await gate;
      },
    });
    const { engine, sql } = await startEngine(base.assemble({ handlers: [room] }));
    const { handle } = await connect(engine);

    const subscribing = handle.handleMessage(subscribeFrame);
    await macrotask();
    await purgeUser(engine.core, 'ama');
    open();
    await subscribing;

    expect(listMembershipsByUser(sql, 'ama')).toEqual([]);
  });

  it('leaves no replay row when the open socket sends a frame during the purge', async () => {
    const base = server({
      capabilities: [
        emits({ said: t<{ text: string }>() }),
        dedup(),
        sequence({ persist: true }),
        replay.history(),
      ],
    });
    const handleSay = base.on('say', {
      run(ctx) {
        ctx.send('said', { text: 'hello' });
      },
    });
    const { engine, sql } = await startEngine(base.assemble({ handlers: [handleSay] }));
    const { handle } = await connect(engine);

    engine.core.hooks.purgeUser.push(() => handle.handleMessage(JSON.stringify(['say', {}, null])));
    await purgeUser(engine.core, 'ama');

    expect(
      sql
        .exec<{ n: number }>('SELECT COUNT(*) AS n FROM __livething_replay WHERE userId = ?', 'ama')
        .one(),
    ).toMatchObject({ n: 0 });
  });
});

describe('a connection that closes during an async check', () => {
  it('does not run commit', async () => {
    const { gate, open } = deferred();
    const commit = vi.fn();
    const base = server({ capabilities: [channels()] });
    const room = base.channel('room', {
      async check() {
        await gate;
      },
      commit,
    });
    const { engine } = await startEngine(base.assemble({ handlers: [room] }));

    const { handle } = await connect(engine);

    const subscribing = handle.handleMessage(subscribeFrame);
    await macrotask();
    await handle.handleClose(1000, 'bye');
    open();
    await subscribing;

    expect(commit).not.toHaveBeenCalled();
  });
});

describe('a server-started subscribe of another connection', () => {
  it('orders that connection frames after onSubscribe, like a client subscribe', async () => {
    const { gate, open } = deferred();
    const order: string[] = [];
    const refs = new Map<string, ConnectionRef>();
    const base = server({
      capabilities: [channels()],
      onConnect(ctx) {
        refs.set(ctx.user.id, ctx.connection);
      },
    });
    const room = base.channel('room', {
      async onSubscribe() {
        order.push('onSubscribe started');
        await gate;
        order.push('onSubscribe ended');
      },
    });

    const handleSay = room.on('say', {
      run() {
        order.push('say');
      },
    });

    const handleAdd = base.on('add-ama', {
      async run(ctx) {
        await ctx.channels.get(room).subscribe(refs.get('ama')!);
      },
    });
    const { engine } = await startEngine(base.assemble({ handlers: [handleAdd, handleSay] }));
    const ama = await connect(engine, 'ama');
    const kofi = await connect(engine, 'kofi');

    const adding = kofi.handle.handleMessage(JSON.stringify(['add-ama', {}, null]));
    await vi.waitFor(() => expect(order).toEqual(['onSubscribe started']));

    const saying = ama.handle.handleMessage(sayFrame);
    await macrotask();
    open();
    await Promise.all([adding, saying]);

    expect(order).toEqual(['onSubscribe started', 'onSubscribe ended', 'say']);
  });
});
