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
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';

type Frame = [event: string, payload: Record<string, unknown>, livething: Record<string, unknown>];

const Text = t<{ text: string }>();

function buildDefinition(replayCapability: ReturnType<typeof replay.history>) {
  const base = server({
    capabilities: [
      emits({ secret: Text, news: Text }),
      dedup(),
      sequence({ persist: true }),
      replayCapability,
      channels(),
      tags((ephemeral) => [ephemeral('team', t<string>())]),
    ],
  });
  const room = base.channel('room', {
    capabilities: [emits({ 'room-news': Text })],
  });

  return base.assemble({
    handlers: [
      room,
      base.on('say-secret', {
        input: v.object({ text: v.string() }),
        run(ctx, payload) {
          ctx.send('secret', { text: payload.text });
        },
      }),
      base.on('join-team', {
        input: v.object({ team: v.string() }),
        run(ctx, payload) {
          ctx.tags.ephemeral('team').add(payload.team);
        },
      }),
      base.on('team-shout', {
        input: v.object({ team: v.string() }),
        run(ctx, payload) {
          ctx.tags
            .ephemeral('team')
            .ref(payload.team)
            .broadcast('secret', { text: `team-${payload.team}` });
        },
      }),
      base.on('every-team-shout', {
        run(ctx) {
          ctx.tags.ephemeral('team').broadcast('secret', { text: 'every-team' });
        },
      }),
      base.on('shout', {
        run(ctx) {
          ctx.broadcast('news', { text: 'top-news' });
        },
      }),
      base.on('shout-with-self', {
        run(ctx) {
          ctx.broadcast('news', { text: 'top-news' }, { includeSelf: true });
        },
      }),
      room.on('room-shout', {
        run(ctx) {
          ctx.channel.broadcast('room-news', { text: 'room-news' });
        },
      }),
      room.on('room-shout-with-self', {
        run(ctx) {
          ctx.channel.broadcast('room-news', { text: 'room-news' }, { includeSelf: true });
        },
      }),
    ],
  });
}

async function buildEngine(
  replayCapability: ReturnType<typeof replay.history> = replay.history({ durability: 'strict' }),
): Promise<Engine> {
  let captured: Engine | undefined;
  const runAdapter = adapter({
    id: 'replay-audience-spec',
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
  runAdapter(buildDefinition(replayCapability), undefined as never);
  if (!captured) throw new Error('engine not captured');

  await captured.initialize();

  return captured;
}

async function connect(engine: Engine, userId: string) {
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
    userId,
    frames,
    token: String(frames.find(([event]) => event === '__resume__')?.[1].token),
    send: (frame: unknown[]) =>
      handle.handleMessage(JSON.stringify(frame.length === 2 ? [...frame, null] : frame)),
  };
}

type Client = Awaited<ReturnType<typeof connect>>;

function replayRowCount(engine: Engine): number {
  const row = engine.core.storage.sql
    .exec<{ n: number }>('SELECT COUNT(*) AS n FROM __livething_replay')
    .one();
  return Number(row?.n);
}

async function requestReplay(client: Client, channel?: string, resume?: string[]) {
  const start = client.frames.length;
  const payload = resume ? { lastKnownSeq: 0, resume } : { lastKnownSeq: 0 };
  await client.send(['__replay__', payload, channel ? { channel: { name: channel } } : null]);
  return client.frames
    .slice(start)
    .filter(([event]) => !event.startsWith('__'))
    .map(([event, body]) => `${event}:${String(body.text)}`);
}

async function subscribe(client: Client) {
  await client.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
}

async function reconnectToRoom(engine: Engine, userId: string) {
  const again = await connect(engine, userId);
  await subscribe(again);
  return again;
}

async function gapAfter(client: Client, since: number, resume: string[]) {
  const start = client.frames.length;
  await client.send(['__replay__', { lastKnownSeq: since, resume }, null]);
  const gap = client.frames.slice(start).find(([event]) => event === '__gap__');
  return gap ? gap[1].missedThrough : null;
}

function seqOf(client: Client, text: string): number {
  const frame = client.frames.find(([, payload]) => payload.text === text);
  if (!frame) throw new Error(`no frame with text "${text}"`);

  return (frame[2].delivery as { seq: number }).seq;
}

describe('a broadcast to chosen users stores its payload once', () => {
  it('stores one row for a tag broadcast to three users, and replays it to each of them', async () => {
    const engine = await buildEngine();
    const members = [
      await connect(engine, 'alice'),
      await connect(engine, 'bob'),
      await connect(engine, 'carol'),
    ];
    const dave = await connect(engine, 'dave');
    for (const member of members) await member.send(['join-team', { team: 'red' }]);

    await dave.send(['team-shout', { team: 'red' }]);

    expect(replayRowCount(engine)).toBe(1);
    for (const member of members) {
      const again = await connect(engine, member.userId);
      expect(await requestReplay(again, undefined, [member.token])).toEqual(['secret:team-red']);
    }

    const daveAgain = await connect(engine, 'dave');
    expect(await requestReplay(daveAgain, undefined, [dave.token])).toEqual([]);
  });

  it('stores one row for a tag group broadcast to two users, and replays it to each of them', async () => {
    const engine = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    const carol = await connect(engine, 'carol');
    await alice.send(['join-team', { team: 'red' }]);

    await bob.send(['join-team', { team: 'blue' }]);
    await carol.send(['every-team-shout', {}]);

    expect(replayRowCount(engine)).toBe(1);
    for (const member of [alice, bob]) {
      const again = await connect(engine, member.userId);
      expect(await requestReplay(again, undefined, [member.token])).toEqual(['secret:every-team']);
    }

    const carolAgain = await connect(engine, 'carol');
    expect(await requestReplay(carolAgain, undefined, [carol.token])).toEqual([]);
  });
});

describe('replay leaves out the sender a broadcast excluded', () => {
  it('does not replay a top-level broadcast to the sender showing its own token', async () => {
    const engine = await buildEngine();
    const alice = await connect(engine, 'alice');
    await connect(engine, 'bob');

    await alice.send(['shout', {}]);

    const aliceAgain = await connect(engine, 'alice');
    expect(await requestReplay(aliceAgain, undefined, [alice.token])).toEqual([]);
  });

  it('does not replay a channel broadcast to the sender showing its own token', async () => {
    const engine = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await subscribe(alice);
    await subscribe(bob);

    await alice.send(['room-shout', {}, { channel: { name: 'room' } }]);

    const aliceAgain = await reconnectToRoom(engine, 'alice');
    expect(await requestReplay(aliceAgain, 'room', [alice.token])).toEqual([]);
  });

  it('still replays an excluded broadcast to another tab of the sender without that token', async () => {
    const engine = await buildEngine();
    const alice = await connect(engine, 'alice');
    await subscribe(alice);
    await alice.send(['shout', {}]);
    await alice.send(['room-shout', {}, { channel: { name: 'room' } }]);

    const otherTab = await reconnectToRoom(engine, 'alice');
    expect(await requestReplay(otherTab)).toEqual(['news:top-news']);
    expect(await requestReplay(otherTab, 'room')).toEqual(['room-news:room-news']);
  });

  it('still replays an includeSelf broadcast to the sender showing its own token', async () => {
    const engine = await buildEngine();
    const alice = await connect(engine, 'alice');
    await subscribe(alice);
    await alice.send(['shout-with-self', {}]);
    await alice.send(['room-shout-with-self', {}, { channel: { name: 'room' } }]);

    const aliceAgain = await reconnectToRoom(engine, 'alice');
    expect(await requestReplay(aliceAgain, undefined, [alice.token])).toEqual(['news:top-news']);
    expect(await requestReplay(aliceAgain, 'room', [alice.token])).toEqual(['room-news:room-news']);
  });
});

describe('anonymous connections keep separate replay retention', () => {
  it('reports no gap to an anonymous client when another anonymous client rows are evicted', async () => {
    const engine = await buildEngine(replay.history({ retention: { maxMessages: 2 } }));
    const first = await connect(engine, '');
    const second = await connect(engine, '');
    await first.send(['say-secret', { text: 'first-0' }]);
    const before = seqOf(first, 'first-0') - 1;

    for (let i = 0; i < 5; i += 1) await second.send(['say-secret', { text: `second-${i}` }]);

    const again = await connect(engine, '');
    expect(await gapAfter(again, before, [first.token])).toBeNull();
    expect(await requestReplay(again, undefined, [first.token])).toEqual(['secret:first-0']);
  });

  it('reports a gap up to the anonymous client own evicted rows', async () => {
    const engine = await buildEngine(replay.history({ retention: { maxMessages: 2 } }));
    const first = await connect(engine, '');
    const second = await connect(engine, '');
    for (let i = 0; i < 4; i += 1) {
      await first.send(['say-secret', { text: `first-${i}` }]);
      await second.send(['say-secret', { text: `second-${i}` }]);
    }

    const again = await connect(engine, '');
    const since = seqOf(first, 'first-0');
    expect(await gapAfter(again, since, [first.token])).toBe(seqOf(first, 'first-1'));
  });
});
