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
import type { ReplayDurability } from '~/replay/types.ts';

type Frame = [event: string, payload: Record<string, unknown>, livething: Record<string, unknown>];

interface Client {
  userId: string;
  frames: Frame[];
  send(frame: unknown[]): Promise<void>;
  close(): Promise<void>;
}

const Text = t<{ text: string }>();

function buildDefinition(refs: Map<string, ConnectionRef>, durability: ReplayDurability) {
  const base = server({
    capabilities: [
      emits({ secret: Text, news: Text, dm: Text }),
      dedup(),
      sequence({ persist: true }),
      replay.history({ durability }),
      channels(),
    ],
  });

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

  const shout = base.on('shout', {
    run(ctx) {
      ctx.broadcast('news', { text: 'top-news' });
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

  return base.assemble({
    handlers: [
      sendSecret,
      sendToRef,
      sendToUser,
      shout,
      room,
      roomShout,
      roomWhisper,
      roomWhisperToUser,
    ],
  });
}

async function buildEngine(
  durability: ReplayDurability = 'strict',
): Promise<{ engine: Engine; refs: Map<string, ConnectionRef> }> {
  const refs = new Map<string, ConnectionRef>();
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'replay-recording-spec',
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
  runAdapter(buildDefinition(refs, durability), undefined as never);
  if (!captured) throw new Error('engine not captured');

  await captured.initialize();

  return { engine: captured, refs };
}

async function connect(engine: Engine, userId: string): Promise<Client & { id: string }> {
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
    userId,
    frames,
    send: (frame) =>
      handle.handleMessage(JSON.stringify(frame.length === 2 ? [...frame, null] : frame)),
    close: () => handle.handleClose(1000, 'bye'),
  };
}

async function requestReplay(client: Client, channel?: string): Promise<string[]> {
  const start = client.frames.length;
  await client.send(
    channel === undefined
      ? ['__replay__', { lastKnownSeq: 0 }, null]
      : ['__replay__', { lastKnownSeq: 0 }, { channel: { name: channel } }],
  );
  return client.frames
    .slice(start)
    .filter(([event]) => !event.startsWith('__'))
    .map(([event, payload]) => `${event}:${String(payload.text)}`);
}

describe('built-in replay records only what the requester may see', () => {
  it('never replays a ctx.send frame to another connection', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['send-secret', {}]);
    expect(alice.frames.map(([event]) => event)).toContain('secret');

    const bob = await connect(engine, 'bob');
    expect(await requestReplay(bob)).toEqual([]);
  });

  it('never replays a ctx.connections.get(ref).send frame to another connection', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await alice.send(['send-to-ref', { id: bob.id }]);
    expect(bob.frames.map(([event]) => event)).toContain('secret');

    const carol = await connect(engine, 'carol');
    expect(await requestReplay(carol)).toEqual([]);
  });

  it('never replays a channel ctx.channel.send frame to another member', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    await alice.send(['room-whisper', {}, { channel: { name: 'room' } }]);
    expect(alice.frames.map(([event]) => event)).toContain('whisper');

    const bob = await connect(engine, 'bob');
    await bob.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    expect(await requestReplay(bob, 'room')).toEqual([]);
  });

  it('replays a user-addressed frame only to that user, even on a new connection', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bobFirst = await connect(engine, 'bob');
    await alice.send(['send-to-user', { userId: 'bob' }]);
    expect(bobFirst.frames.map(([event]) => event)).toContain('dm');

    await bobFirst.close();

    const bobAgain = await connect(engine, 'bob');
    expect(await requestReplay(bobAgain)).toEqual(['dm:for-bob']);

    const carol = await connect(engine, 'carol');
    expect(await requestReplay(carol)).toEqual([]);

    const anonymous = await connect(engine, '');
    expect(await requestReplay(anonymous)).toEqual([]);
  });

  it('records a user-addressed frame once, even when the user has several tabs', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await connect(engine, 'bob');
    await connect(engine, 'bob');
    await alice.send(['send-to-user', { userId: 'bob' }]);

    const bobThird = await connect(engine, 'bob');
    expect(await requestReplay(bobThird)).toEqual(['dm:for-bob']);
  });

  it('stamps a user-addressed frame once, so every tab sees one message id', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bobTab1 = await connect(engine, 'bob');
    const bobTab2 = await connect(engine, 'bob');
    await alice.send(['send-to-user', { userId: 'bob' }]);

    const messageIds = [bobTab1, bobTab2].map(
      (tab) =>
        (tab.frames.find(([event]) => event === 'dm')?.[2].delivery as { id?: string } | undefined)
          ?.id,
    );
    expect(messageIds[0]).toEqual(expect.any(String));
    expect(messageIds[1]).toBe(messageIds[0]);
  });

  it('replays a channel frame sent to one user only to that user', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    await alice.send(['room-whisper-to-user', { userId: 'bob' }, { channel: { name: 'room' } }]);

    const bob = await connect(engine, 'bob');
    await bob.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    expect(await requestReplay(bob, 'room')).toEqual(['whisper:room-for-bob']);

    const carol = await connect(engine, 'carol');
    await carol.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    expect(await requestReplay(carol, 'room')).toEqual([]);
  });

  it('records a user-addressed frame while that user is offline', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['send-to-user', { userId: 'bob' }]);

    const bob = await connect(engine, 'bob');
    expect(await requestReplay(bob)).toEqual(['dm:for-bob']);
  });
});

describe('built-in replay records a broadcast that reaches nobody', () => {
  it('records a top-level broadcast whose only connection is the excluded sender', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['shout', {}]);

    const bob = await connect(engine, 'bob');
    expect(await requestReplay(bob)).toEqual(['news:top-news']);
  });

  it('records a channel broadcast whose only member is the excluded sender', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    await alice.send(['room-shout', {}, { channel: { name: 'room' } }]);

    const bob = await connect(engine, 'bob');
    await bob.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    expect(await requestReplay(bob, 'room')).toEqual(['room-news:room-news']);
  });

  it('records a broadcast that reaches nobody with best-effort durability too', async () => {
    const { engine } = await buildEngine('best-effort');
    const alice = await connect(engine, 'alice');
    await alice.send(['shout', {}]);
    await Promise.resolve();

    const bob = await connect(engine, 'bob');
    expect(await requestReplay(bob)).toEqual(['news:top-news']);
  });

  it('records a broadcast once when several members receive it', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await connect(engine, 'bob');
    await connect(engine, 'carol');
    await alice.send(['shout', {}]);

    const dave = await connect(engine, 'dave');
    expect(await requestReplay(dave)).toEqual(['news:top-news']);
  });
});
