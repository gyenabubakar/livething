import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ConnectionRef } from '~/context.ts';
import type { OutgoingWireMessage } from '~/replay/custom/custom.ts';

type Frame = [event: string, payload: Record<string, unknown>, livething: Record<string, unknown>];

interface Client {
  id: string;
  frames: Frame[];
  send(frame: unknown[]): Promise<void>;
  close(): Promise<void>;
}

interface StoredRow {
  hook: 'before' | 'after';
  event: string;
  text: string;
  channel: string | null;
  userId: string | null;
  deliverySeq: number;
  messageId: string;
}

interface Harness {
  engine: Engine;
  refs: Map<string, ConnectionRef>;
  rows: StoredRow[];
  replayUserIds: (string | null)[];
}

interface HarnessOptions {
  registerHooks?: boolean;
  failBeforeBroadcast?: boolean;
}

const Text = t<{ text: string }>();

function toRow(hook: StoredRow['hook'], message: OutgoingWireMessage): StoredRow {
  return {
    hook,
    event: message.event,
    text: String(message.payload.text),
    channel: message.wire.channel,
    userId: message.userId,
    deliverySeq: message.wire.deliverySeq,
    messageId: message.wire.messageId,
  };
}

function buildDefinition(harness: Omit<Harness, 'engine'>, options: HarnessOptions) {
  const { refs, rows, replayUserIds } = harness;
  const base = server({
    capabilities: [
      emits({ secret: Text, news: Text, dm: Text }),
      dedup(),
      sequence({ persist: true }),
      replay.custom(),
      channels(),
    ],
  });

  if (options.registerHooks ?? true) {
    base.replay({
      beforeBroadcast(_ctx, message) {
        if (options.failBeforeBroadcast) throw new Error('store is down');

        rows.push(toRow('before', message));
      },
      afterBroadcast(_ctx, message) {
        rows.push(toRow('after', message));
      },
      replay(ctx, since) {
        replayUserIds.push(ctx.userId);
        const visible = rows.filter(
          (row) =>
            row.hook === 'before' &&
            row.channel === null &&
            row.deliverySeq > since &&
            (row.userId === null || row.userId === ctx.userId),
        );
        for (const row of visible) {
          ctx.sendReplay(
            row.event,
            { text: row.text },
            { deliverySeq: row.deliverySeq, messageId: row.messageId },
          );
        }
      },
    });
  }

  base.onConnect((ctx) => {
    refs.set(ctx.connection.id, ctx.connection);
  });

  const sendSecret = base.on('send-secret', {
    run(ctx) {
      ctx.send('secret', { text: 'unicast' });
    },
  });

  const sendToRef = base.on('send-to-ref', {
    input: v.object({ id: v.string() }),
    run(ctx, payload) {
      ctx.connections.get(refs.get(payload.id)!).send('secret', { text: 'by-ref' });
    },
  });

  const sendToUser = base.on('send-to-user', {
    input: v.object({ userId: v.string() }),
    run(ctx, payload) {
      ctx.users.get(payload.userId).broadcast('dm', { text: `for-${payload.userId}` });
    },
  });

  const sendToSelfUser = base.on('send-to-self-user', {
    run(ctx) {
      ctx.user.broadcast('dm', { text: 'for-me' });
    },
  });

  const shout = base.on('shout', {
    run(ctx) {
      ctx.broadcast('news', { text: 'top-news' });
    },
  });

  const resend = base.on('resend', {
    run(ctx) {
      ctx.sendReplay('news', { text: 'resent' }, { deliverySeq: 7, messageId: 'm-7' });
    },
  });

  // A Date is an object in memory but a string in JSON, so the call itself throws.
  const resendDate = base.on('resend-date', {
    run(ctx) {
      try {
        ctx.sendReplay('news', new Date(0) as never, { deliverySeq: 8, messageId: 'm-8' });
      } catch (error) {
        ctx.send('news', { text: `refused:${(error as Error).message.includes('JSON')}` });
      }
    },
  });

  const room = base.channel('room', {
    capabilities: [emits({ 'room-news': Text, whisper: Text })],
  });

  const roomShout = room.on('room-shout', {
    run(ctx) {
      ctx.channel.broadcast('room-news', { text: 'room-news' });
    },
  });

  const roomWhisper = room.on('room-whisper', {
    run(ctx) {
      ctx.channel.send('whisper', { text: 'room-unicast' });
      ctx.channel.broadcastTo(ctx.connection, 'whisper', { text: 'room-to-connection' });
    },
  });

  const roomWhisperToUser = room.on('room-whisper-to-user', {
    input: v.object({ userId: v.string() }),
    run(ctx, payload) {
      ctx.channel.broadcastTo(ctx.users.get(payload.userId).ref(), 'whisper', {
        text: `room-for-${payload.userId}`,
      });
    },
  });

  const roomResend = room.on('room-resend', {
    run(ctx) {
      ctx.channel.sendReplay?.(
        'room-news',
        { text: 'room-resent' },
        {
          deliverySeq: 9,
          messageId: 'm-9',
        },
      );
    },
  });

  return base.assemble({
    handlers: [
      sendSecret,
      sendToRef,
      sendToUser,
      sendToSelfUser,
      shout,
      resend,
      resendDate,
      room,
      roomShout,
      roomWhisper,
      roomWhisperToUser,
      roomResend,
    ],
  });
}

async function buildEngine(options: HarnessOptions = {}): Promise<Harness> {
  const harness = {
    refs: new Map<string, ConnectionRef>(),
    rows: [] as StoredRow[],
    replayUserIds: [] as (string | null)[],
  };

  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'custom-replay-recording-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      captured = createEngine({
        storage: createTestStorage(),
        platform: {},
        timers: createTestTimers(),
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  });
  runAdapter(buildDefinition(harness, options), undefined as never);
  if (!captured) throw new Error('engine not captured');

  await captured.initialize();

  return { engine: captured, ...harness };
}

async function connect(engine: Engine, userId: string): Promise<Client> {
  const frames: Frame[] = [];
  const before = new Set(engine.core.connections.keys());
  const handle = engine.accept(Symbol(userId || 'anon'), {
    send(data: string) {
      frames.push(JSON.parse(data) as Frame);
    },
    close() {},
    bufferedAmount: () => 0,
    userId,
  });
  const connection = [...engine.core.connections.values()].find((c) => !before.has(c.id))!;
  await connection.lifecycleReady;

  return {
    id: connection.id,
    frames,
    send: (frame) =>
      handle.handleMessage(JSON.stringify(frame.length === 2 ? [...frame, null] : frame)),
    close: () => handle.handleClose(1000, 'bye'),
  };
}

function texts(frames: Frame[]): string[] {
  return frames
    .filter(([event]) => !event.startsWith('__'))
    .map(([event, payload]) => `${event}:${String(payload.text)}`);
}

async function requestReplay(client: Client): Promise<string[]> {
  const start = client.frames.length;
  await client.send(['__replay__', { lastKnownSeq: 0 }, null]);
  return texts(client.frames.slice(start));
}

function stored(rows: StoredRow[], hook: StoredRow['hook']) {
  return rows
    .filter((row) => row.hook === hook)
    .map(({ event, text, channel, userId }) => ({ event, text, channel, userId }));
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('custom replay hooks see each broadcast once', () => {
  it('never see a send to one connection', async () => {
    const { engine, rows } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');

    await alice.send(['send-secret', {}]);
    await alice.send(['send-to-ref', { id: bob.id }]);
    await alice.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    await alice.send(['room-whisper', {}, { channel: { name: 'room' } }]);
    await settle();

    expect(texts(alice.frames)).toEqual(
      expect.arrayContaining(['secret:unicast', 'whisper:room-unicast']),
    );
    expect(texts(bob.frames)).toContain('secret:by-ref');
    expect(rows).toEqual([]);
  });

  it('see a broadcast once, however many connections receive it', async () => {
    const { engine, rows } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await connect(engine, 'bob');
    await connect(engine, 'carol');

    await alice.send(['shout', {}]);
    await settle();

    const expected = [{ event: 'news', text: 'top-news', channel: null, userId: null }];
    expect(stored(rows, 'before')).toEqual(expected);
    expect(stored(rows, 'after')).toEqual(expected);
  });

  it('see a broadcast that reaches nobody live', async () => {
    const { engine, rows } = await buildEngine();
    const alice = await connect(engine, 'alice');

    await alice.send(['shout', {}]);
    await alice.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    await alice.send(['room-shout', {}, { channel: { name: 'room' } }]);
    await settle();

    expect(texts(alice.frames)).toEqual([]);
    expect(stored(rows, 'before')).toEqual([
      { event: 'news', text: 'top-news', channel: null, userId: null },
      { event: 'room-news', text: 'room-news', channel: 'room', userId: null },
    ]);
    expect(stored(rows, 'after')).toHaveLength(2);
  });

  it('see a broadcast to one user once, with that user as its scope', async () => {
    const { engine, rows } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await connect(engine, 'bob');
    await connect(engine, 'bob');

    await alice.send(['send-to-user', { userId: 'bob' }]);
    await alice.send(['send-to-user', { userId: 'dave' }]);
    await alice.send(['send-to-self-user', {}]);
    await settle();

    expect(stored(rows, 'before')).toEqual([
      { event: 'dm', text: 'for-bob', channel: null, userId: 'bob' },
      { event: 'dm', text: 'for-dave', channel: null, userId: 'dave' },
      { event: 'dm', text: 'for-me', channel: null, userId: 'alice' },
    ]);
  });

  it('see a channel broadcast to one user with that user as its scope', async () => {
    const { engine, rows } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    await alice.send(['room-whisper-to-user', { userId: 'bob' }, { channel: { name: 'room' } }]);
    await settle();

    expect(stored(rows, 'before')).toEqual([
      { event: 'whisper', text: 'room-for-bob', channel: 'room', userId: 'bob' },
    ]);
  });

  it('give each broadcast the real deliverySeq and messageId from sequence and dedup', async () => {
    const { engine, rows } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');

    await alice.send(['shout', {}]);
    await alice.send(['shout', {}]);
    await settle();

    const before = rows.filter((row) => row.hook === 'before');
    const after = rows.filter((row) => row.hook === 'after');
    expect(before).toHaveLength(2);
    for (const row of before) {
      expect(Number.isInteger(row.deliverySeq)).toBe(true);
      expect(row.messageId).not.toBe('undefined');
      expect(row.messageId.length).toBeGreaterThan(0);
    }

    expect(before[1]!.deliverySeq).toBeGreaterThan(before[0]!.deliverySeq);
    expect(before[1]!.messageId).not.toBe(before[0]!.messageId);

    expect(after.map((row) => [row.deliverySeq, row.messageId])).toEqual(
      before.map((row) => [row.deliverySeq, row.messageId]),
    );

    const bobNews = bob.frames.filter(([event]) => event === 'news');
    expect(bobNews.map(([, , livething]) => livething.delivery)).toEqual(
      before.map((row) => ({ id: row.messageId, seq: row.deliverySeq })),
    );
  });

  it('stop the broadcast for everyone when beforeBroadcast throws', async () => {
    const { engine, rows } = await buildEngine({ failBeforeBroadcast: true });
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await alice.send(['shout', {}]);
    await settle();

    expect(texts(bob.frames)).toEqual([]);
    expect(stored(rows, 'after')).toEqual([]);
  });
});

describe('custom replay load side', () => {
  it('passes the requesting user to replay, and null for an anonymous connection', async () => {
    const { engine, replayUserIds } = await buildEngine();
    const bob = await connect(engine, 'bob');
    const anonymous = await connect(engine, '');
    await requestReplay(bob);
    await requestReplay(anonymous);

    expect(replayUserIds).toEqual(['bob', null]);
  });

  it('lets replay hand a user-scoped message only to that user', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['send-to-user', { userId: 'bob' }]);
    await alice.send(['shout', {}]);

    const bob = await connect(engine, 'bob');
    const carol = await connect(engine, 'carol');
    const anonymous = await connect(engine, '');

    expect(await requestReplay(bob)).toEqual(['dm:for-bob', 'news:top-news']);
    expect(await requestReplay(carol)).toEqual(['news:top-news']);
    expect(await requestReplay(anonymous)).toEqual(['news:top-news']);
  });
});

describe('ctx.sendReplay with replay.custom()', () => {
  it('resends a top-level frame from a handler', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['resend', {}]);

    expect(texts(alice.frames)).toEqual(['news:resent']);
  });

  it('resends a channel frame from a channel handler', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    await alice.send(['room-resend', {}, { channel: { name: 'room' } }]);

    expect(texts(alice.frames)).toEqual(['room-news:room-resent']);
  });

  it('throws at the call for a payload that is not an object in JSON, such as a Date', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['resend-date', {}]);

    expect(texts(alice.frames)).toEqual(['news:refused:true']);
  });

  it('works when replay.custom() is listed without base.replay()', async () => {
    const { engine } = await buildEngine({ registerHooks: false });
    const alice = await connect(engine, 'alice');
    await alice.send(['resend', {}]);

    expect(texts(alice.frames)).toEqual(['news:resent']);
  });
});
