import { AsyncLocalStorage } from 'node:async_hooks';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { purgeUser } from '~/_engine/runtime/purge-user.ts';
import { createTestStorage } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { channels } from '~/channel/capability.ts';
import { dedup } from '~/dedup/capability.ts';
import { emits } from '~/emits/emits.ts';
import { replay } from '~/replay/capability.ts';
import { sequence } from '~/sequence/capability.ts';
import { tags } from '~/tags/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { Engine } from '~/_engine/engine.ts';
import type { ConnectionRef } from '~/context.ts';

type Frame = [event: string, payload: Record<string, unknown>, livething: Record<string, unknown>];

interface Client {
  userId: string;
  frames: Frame[];
  /** The resume token this connection got in `__resume__`. */
  token: string;
  send(frame: unknown[]): Promise<void>;
  close(): Promise<void>;
}

const Text = t<{ text: string }>();

function buildDefinition(
  refs: Map<string, ConnectionRef>,
  replayCapability: ReplayCapability,
  sendResults: boolean[],
) {
  const base = server({
    capabilities: [
      emits({ secret: Text, news: Text, dm: Text }),
      dedup(),
      sequence({ persist: true }),
      replayCapability,
      channels(),
      tags((ephemeral) => [ephemeral('team', t<string>())]),
    ],
    onConnect(ctx) {
      refs.set(ctx.connection.id, ctx.connection);
    },
  });

  const saySecret = base.on('say-secret', {
    input: v.object({ text: v.string() }),
    run(ctx, payload) {
      sendResults.push(ctx.send('secret', { text: payload.text }));
    },
  });

  const joinTeam = base.on('join-team', {
    input: v.object({ team: v.string() }),
    run(ctx, payload) {
      ctx.tags.ephemeral('team').add(payload.team);
    },
  });

  const teamShout = base.on('team-shout', {
    input: v.object({ team: v.string() }),
    run(ctx, payload) {
      ctx.tags
        .ephemeral('team')
        .ref(payload.team)
        .broadcast('secret', { text: `team-${payload.team}` });
    },
  });

  const everyTeamShout = base.on('every-team-shout', {
    run(ctx) {
      ctx.tags.ephemeral('team').broadcast('secret', { text: 'every-team' });
    },
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

  const roomWhisperToRef = room.on('room-whisper-to-ref', {
    input: v.object({ id: v.string() }),
    run(ctx, payload) {
      ctx.channel.broadcastTo(refs.get(payload.id)!, 'whisper', { text: 'room-by-ref' });
    },
  });

  const roomWhisperToTeam = room.on('room-whisper-to-team', {
    input: v.object({ team: v.string() }),
    run(ctx, payload) {
      ctx.channel.broadcastTo(ctx.tags.ephemeral('team').ref(payload.team), 'whisper', {
        text: `room-team-${payload.team}`,
      });
    },
  });

  return base.assemble({
    handlers: [
      saySecret,
      joinTeam,
      teamShout,
      everyTeamShout,
      roomWhisperToRef,
      roomWhisperToTeam,
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

type ReplayCapability = ReturnType<typeof replay.history>;

async function buildEngine(
  replayCapability: ReplayCapability = replay.history({ durability: 'strict' }),
): Promise<{ engine: Engine; refs: Map<string, ConnectionRef>; sendResults: boolean[] }> {
  const refs = new Map<string, ConnectionRef>();
  const sendResults: boolean[] = [];
  const engine = await startEngine(buildDefinition(refs, replayCapability, sendResults));
  return { engine, refs, sendResults };
}

/** Make the replay row inserts throw, for the inserts `fails` picks (counted from 1). */
function failReplayInserts(engine: Engine, fails: (insert: number) => boolean): void {
  const { sql } = engine.core.storage;
  const exec = sql.exec.bind(sql);
  let inserts = 0;
  sql.exec = ((query: string, ...params: unknown[]) => {
    if (/INTO __livething_replay(_recipient)?\s/.test(query) && fails(++inserts)) {
      throw new Error('disk full');
    }

    return exec(query, ...params);
  }) as typeof sql.exec;
}

function countReplayRows(engine: Engine, where = '1 = 1', ...params: unknown[]): number {
  const row = engine.core.storage.sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM __livething_replay WHERE ${where}`, ...params)
    .one();
  return Number(row?.n);
}

async function startEngine(definition: Parameters<ReturnType<typeof adapter>>[0]): Promise<Engine> {
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
  runAdapter(definition, undefined as never);
  if (!captured) throw new Error('engine not captured');

  await captured.initialize();

  return captured;
}

async function connect(engine: Engine, userId: string): Promise<Client & { id: string }> {
  const frames: Frame[] = [];
  const before = new Set(engine.core.connections.keys());
  const handle = engine.accept(Symbol(userId || 'anon'), {
    send({ text: data }: { kind: 'text'; text: string }) {
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
    token: String(frames.find(([event]) => event === '__resume__')?.[1].token),
    send: (frame) =>
      handle.handleMessage(JSON.stringify(frame.length === 2 ? [...frame, null] : frame)),
    close: () => handle.handleClose(1000, 'bye'),
  };
}

async function requestReplay(
  client: Client,
  channel?: string,
  resume?: string[],
): Promise<string[]> {
  const start = client.frames.length;
  const payload = resume ? { lastKnownSeq: 0, resume } : { lastKnownSeq: 0 };
  await client.send(
    channel === undefined
      ? ['__replay__', payload, null]
      : ['__replay__', payload, { channel: { name: channel } }],
  );
  return client.frames
    .slice(start)
    .filter(([event]) => !event.startsWith('__'))
    .map(([event, payload]) => `${event}:${String(payload.text)}`);
}

describe('replay records only what the requester may see', () => {
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

describe('replay records a broadcast that reaches nobody', () => {
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
    const { engine } = await buildEngine(replay.history({ durability: 'best-effort' }));
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

describe('replay of frames sent to chosen connections', () => {
  it('gives each connection its own resume token in its first frame', async () => {
    const { engine } = await buildEngine();
    const first = await connect(engine, 'alice');
    const second = await connect(engine, 'alice');

    expect(first.frames[0]?.[0]).toBe('__resume__');
    expect(first.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.token).not.toBe(first.token);
  });

  it('puts a sequence number in the resume frame, after every frame sent before it', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const carol = await connect(engine, 'carol');
    await alice.send(['shout', {}]);
    const before = seqOf(carol, 'top-news');

    const bob = await connect(engine, 'bob');
    const resumeSeq = bob.frames.find(([event]) => event === '__resume__')?.[1].seq;
    await alice.send(['say-secret', { text: 'after' }]);

    expect(resumeSeq).toEqual(expect.any(Number));
    expect(resumeSeq).toBeGreaterThan(before);
    expect(seqOf(alice, 'after')).toBeGreaterThan(resumeSeq as number);
  });

  it('sends no resume token when replay is off', async () => {
    const engine = await startEngine(
      server({ capabilities: [emits({ secret: Text })] }).assemble({ handlers: [] }),
    );
    const alice = await connect(engine, 'alice');

    expect(alice.frames.map(([event]) => event)).not.toContain('__resume__');
  });

  it('replays a ctx.send frame to the same user showing the old connection token', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['send-secret', {}]);
    await alice.close();

    const aliceAgain = await connect(engine, 'alice');
    expect(await requestReplay(aliceAgain, undefined, [alice.token])).toEqual(['secret:unicast']);
  });

  it('does not replay a ctx.send frame without its token, or to another user with it', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['send-secret', {}]);

    const aliceOtherTab = await connect(engine, 'alice');
    expect(await requestReplay(aliceOtherTab)).toEqual([]);
    expect(await requestReplay(aliceOtherTab, undefined, [aliceOtherTab.token])).toEqual([]);

    const bob = await connect(engine, 'bob');
    expect(await requestReplay(bob, undefined, [alice.token])).toEqual([]);

    const anonymous = await connect(engine, '');
    expect(await requestReplay(anonymous, undefined, [alice.token])).toEqual([]);
  });

  it('replays a ctx.send frame to an anonymous connection only with its token', async () => {
    const { engine } = await buildEngine();
    const first = await connect(engine, '');
    await first.send(['send-secret', {}]);

    const other = await connect(engine, '');
    expect(await requestReplay(other)).toEqual([]);
    expect(await requestReplay(other, undefined, [first.token])).toEqual(['secret:unicast']);

    const alice = await connect(engine, 'alice');
    expect(await requestReplay(alice, undefined, [first.token])).toEqual([]);
  });

  it('replays a ctx.connections.get(ref).send frame under the target connection token', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await alice.send(['send-to-ref', { id: bob.id }]);

    const bobAgain = await connect(engine, 'bob');
    expect(await requestReplay(bobAgain, undefined, [bob.token])).toEqual(['secret:by-ref']);

    const aliceAgain = await connect(engine, 'alice');
    expect(await requestReplay(aliceAgain, undefined, [alice.token])).toEqual([]);
  });

  it('replays a ctx.channel.send frame in its channel', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    await alice.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    await alice.send(['room-whisper', {}, { channel: { name: 'room' } }]);

    const aliceAgain = await connect(engine, 'alice');
    await aliceAgain.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    expect(await requestReplay(aliceAgain, undefined, [alice.token])).toEqual([]);
    expect(await requestReplay(aliceAgain, 'room', [alice.token])).toEqual([
      'whisper:room-unicast',
    ]);
  });

  it('replays a channel broadcastTo(connectionRef) frame to that connection only', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    for (const client of [alice, bob]) {
      await client.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    }

    await alice.send(['room-whisper-to-ref', { id: bob.id }, { channel: { name: 'room' } }]);

    const bobAgain = await connect(engine, 'bob');
    await bobAgain.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    expect(await requestReplay(bobAgain, 'room', [bob.token])).toEqual(['whisper:room-by-ref']);

    const aliceAgain = await connect(engine, 'alice');
    await aliceAgain.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    expect(await requestReplay(aliceAgain, 'room', [alice.token])).toEqual([]);
  });

  it('replays a tag broadcast to each connection that held the tag, and to nobody else', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    const carol = await connect(engine, 'carol');
    await alice.send(['join-team', { team: 'red' }]);

    await bob.send(['join-team', { team: 'red' }]);
    await carol.send(['join-team', { team: 'blue' }]);
    await carol.send(['team-shout', { team: 'red' }]);

    for (const member of [alice, bob]) {
      const again = await connect(engine, member.userId);
      expect(await requestReplay(again, undefined, [member.token])).toEqual(['secret:team-red']);
    }

    const carolAgain = await connect(engine, 'carol');
    expect(await requestReplay(carolAgain, undefined, [carol.token])).toEqual([]);
  });

  it('replays a tag group broadcast to every connection with a key in the group', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    const carol = await connect(engine, 'carol');
    await alice.send(['join-team', { team: 'red' }]);

    await bob.send(['join-team', { team: 'blue' }]);
    await carol.send(['every-team-shout', {}]);

    for (const member of [alice, bob]) {
      const again = await connect(engine, member.userId);
      expect(await requestReplay(again, undefined, [member.token])).toEqual(['secret:every-team']);
    }

    const carolAgain = await connect(engine, 'carol');
    expect(await requestReplay(carolAgain, undefined, [carol.token])).toEqual([]);
  });

  it('replays a channel broadcastTo(tagRef) frame to the tagged members only', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    for (const client of [alice, bob]) {
      await client.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    }

    await bob.send(['join-team', { team: 'red' }]);

    await alice.send(['room-whisper-to-team', { team: 'red' }, { channel: { name: 'room' } }]);

    const bobAgain = await connect(engine, 'bob');
    await bobAgain.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    expect(await requestReplay(bobAgain, 'room', [bob.token])).toEqual(['whisper:room-team-red']);

    const aliceAgain = await connect(engine, 'alice');
    await aliceAgain.send(['__subscribe__', {}, { channel: { name: 'room' } }]);
    expect(await requestReplay(aliceAgain, 'room', [alice.token])).toEqual([]);
  });

  it('stores a frame sent to two tabs of one user as one row', async () => {
    const { engine } = await buildEngine();
    const tab1 = await connect(engine, 'alice');
    const tab2 = await connect(engine, 'alice');
    await tab1.send(['join-team', { team: 'red' }]);
    await tab2.send(['join-team', { team: 'red' }]);

    await tab1.send(['team-shout', { team: 'red' }]);

    const again = await connect(engine, 'alice');
    expect(await requestReplay(again, undefined, [tab1.token, tab2.token])).toEqual([
      'secret:team-red',
    ]);
  });

  it('replays a ctx.send frame with best-effort durability too', async () => {
    const { engine } = await buildEngine(replay.history({ durability: 'best-effort' }));
    const alice = await connect(engine, 'alice');
    await alice.send(['send-secret', {}]);
    await Promise.resolve();

    const aliceAgain = await connect(engine, 'alice');
    expect(await requestReplay(aliceAgain, undefined, [alice.token])).toEqual(['secret:unicast']);
  });
});

/** The `missedThrough` of the `__gap__` a top-level catch-up from `since` gets, or `null`. */
async function gapAfter(client: Client, since: number, resume?: string[]): Promise<unknown> {
  const start = client.frames.length;
  await client.send([
    '__replay__',
    resume ? { lastKnownSeq: since, resume } : { lastKnownSeq: since },
    null,
  ]);
  const gap = client.frames.slice(start).find(([event]) => event === '__gap__');
  return gap ? gap[1].missedThrough : null;
}

function seqOf(client: Client, text: string): number {
  const frame = client.frames.find(([, payload]) => payload.text === text);
  if (!frame) throw new Error(`no frame with text "${text}"`);

  return (frame[2].delivery as { seq: number }).seq;
}

describe('replay retention keeps each audience apart', () => {
  it('private sends never push the shared history out of maxMessages', async () => {
    const { engine } = await buildEngine(replay.history({ retention: { maxMessages: 2 } }));
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await alice.send(['shout', {}]);
    for (let i = 0; i < 6; i += 1) {
      await bob.send(['say-secret', { text: `bob-${i}` }]);
      const anonymous = await connect(engine, '');
      await anonymous.send(['say-secret', { text: `anonymous-${i}` }]);
    }

    const carol = await connect(engine, 'carol');
    expect(await requestReplay(carol)).toEqual(['news:top-news']);

    const bobAgain = await connect(engine, 'bob');
    expect(await requestReplay(bobAgain, undefined, [bob.token])).toEqual([
      'news:top-news',
      'secret:bob-4',
      'secret:bob-5',
    ]);
  });

  it('a dropped private send reports no gap to another user or to a client with no token', async () => {
    const { engine } = await buildEngine(replay.history({ retention: { maxMessages: 2 } }));
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await bob.send(['shout', {}]);
    const since = seqOf(alice, 'top-news');

    for (let i = 0; i < 5; i += 1) {
      await bob.send(['say-secret', { text: `bob-${i}` }]);
      const anonymous = await connect(engine, '');
      await anonymous.send(['say-secret', { text: `anonymous-${i}` }]);
    }

    const aliceAgain = await connect(engine, 'alice');
    expect(await gapAfter(aliceAgain, since, [alice.token])).toBeNull();

    const anonymousWithoutToken = await connect(engine, '');
    expect(await gapAfter(anonymousWithoutToken, since)).toBeNull();
  });

  it('a dropped private send reports a gap to its own user', async () => {
    const { engine } = await buildEngine(replay.history({ retention: { maxMessages: 2 } }));
    const bob = await connect(engine, 'bob');
    await bob.send(['say-secret', { text: 'bob-0' }]);
    const since = seqOf(bob, 'bob-0');
    for (let i = 1; i < 5; i += 1) await bob.send(['say-secret', { text: `bob-${i}` }]);

    const bobAgain = await connect(engine, 'bob');
    expect(await gapAfter(bobAgain, since, [bob.token])).toBe(seqOf(bob, 'bob-2'));
  });

  it('a dropped anonymous private send reports a gap to an anonymous client showing a token', async () => {
    const { engine } = await buildEngine(replay.history({ retention: { maxMessages: 1 } }));
    const first = await connect(engine, '');
    await first.send(['say-secret', { text: 'first-0' }]);
    const since = seqOf(first, 'first-0');
    await first.send(['say-secret', { text: 'first-1' }]);

    await first.send(['say-secret', { text: 'first-2' }]);

    const again = await connect(engine, '');
    expect(await gapAfter(again, since, [first.token])).toBe(seqOf(first, 'first-1'));
  });
});

describe('snapshot replay of sends to chosen connections', () => {
  it('keeps one row per key for a user, which any later connection of that user reads', async () => {
    const { engine } = await buildEngine(replay.snapshot());
    for (let i = 0; i < 5; i += 1) {
      const tab = await connect(engine, 'alice');
      await tab.send(['say-secret', { text: `state-${i}` }]);
    }

    const freshTab = await connect(engine, 'alice');
    expect(await requestReplay(freshTab)).toEqual(['secret:state-4']);
    const rows = engine.core.storage.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM __livething_replay')
      .one();
    expect(Number(rows?.n)).toBe(1);

    const bob = await connect(engine, 'bob');
    expect(await requestReplay(bob)).toEqual([]);
  });

  it('keeps an anonymous connection value under its token', async () => {
    const { engine } = await buildEngine(replay.snapshot());
    const first = await connect(engine, '');
    await first.send(['say-secret', { text: 'anonymous-state' }]);

    const other = await connect(engine, '');
    expect(await requestReplay(other)).toEqual([]);
    expect(await requestReplay(other, undefined, [first.token])).toEqual([
      'secret:anonymous-state',
    ]);
  });

  it('keeps one current value per key for an anonymous connection', async () => {
    const { engine } = await buildEngine(replay.snapshot());
    const first = await connect(engine, '');
    const second = await connect(engine, '');
    await first.send(['join-team', { team: 'red' }]);
    await second.send(['join-team', { team: 'red' }]);

    await first.send(['say-secret', { text: 'own' }]);
    await second.send(['team-shout', { team: 'red' }]);

    const again = await connect(engine, '');
    expect(await requestReplay(again, undefined, [first.token])).toEqual(['secret:team-red']);
    expect(await requestReplay(again, undefined, [second.token])).toEqual(['secret:team-red']);
  });
});

describe('strict replay that cannot store a frame', () => {
  it('blocks a ctx.send, which returns false', async () => {
    const { engine, sendResults } = await buildEngine();
    const alice = await connect(engine, 'alice');
    failReplayInserts(engine, () => true);

    await alice.send(['say-secret', { text: 'lost' }]);

    expect(alice.frames.map(([event]) => event)).not.toContain('secret');
    expect(sendResults).toEqual([false]);
  });

  it('blocks a ctx.connections.get(ref).send', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    failReplayInserts(engine, () => true);

    await alice.send(['send-to-ref', { id: bob.id }]);

    expect(bob.frames.map(([event]) => event)).not.toContain('secret');
  });

  it('keeps no row when the recipients of a blocked send cannot be written', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    await alice.send(['join-team', { team: 'red' }]);
    await bob.send(['join-team', { team: 'red' }]);

    failReplayInserts(engine, (insert) => insert === 2);
    await alice.send(['team-shout', { team: 'red' }]);

    for (const member of [alice, bob]) {
      expect(member.frames.map(([event]) => event)).not.toContain('secret');
    }

    expect(countReplayRows(engine)).toBe(0);
  });

  it('keeps no queued snapshot row for any user when a later user value fails', async () => {
    let reduced = 0;
    const { engine } = await buildEngine(
      replay.snapshot({
        reduce(_previous, next) {
          reduced += 1;
          if (reduced === 2) throw new Error('bad value');

          return next;
        },
      }),
    );
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    for (const member of [alice, bob]) await member.send(['join-team', { team: 'red' }]);

    await alice.send(['team-shout', { team: 'red' }]);

    expect(reduced).toBe(2);
    expect(countReplayRows(engine)).toBe(0);
  });

  it('writes a frame addressed to one user without a transaction', async () => {
    const { engine } = await buildEngine();
    const alice = await connect(engine, 'alice');
    const { sql } = engine.core.storage;
    const transaction = vi.spyOn(sql, 'transaction');

    await alice.send(['send-to-user', { userId: 'bob' }]);

    expect(countReplayRows(engine)).toBe(1);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('purgeUser and replay', () => {
  it('deletes the user replay rows and gap marks, and keeps the rest', async () => {
    const { engine } = await buildEngine(replay.history({ retention: { maxMessages: 1 } }));
    const alice = await connect(engine, 'alice');
    const bob = await connect(engine, 'bob');
    for (let i = 0; i < 3; i += 1) await bob.send(['say-secret', { text: `bob-${i}` }]);

    await alice.send(['send-to-user', { userId: 'bob' }]);
    await alice.send(['say-secret', { text: 'alice-own' }]);
    await alice.send(['shout', {}]);

    function watermarks(): string[] {
      return engine.core.storage.sql
        .exec<{ audience: string }>('SELECT audience FROM __livething_replay_watermark')
        .toArray()
        .map((row) => row.audience);
    }

    expect(watermarks().some((key) => key.includes('user:bob'))).toBe(true);

    await purgeUser(engine.core, 'bob');

    expect(countReplayRows(engine, 'userId = ?', 'bob')).toBe(0);
    expect(watermarks().some((key) => key.includes('user:bob'))).toBe(false);
    const aliceAgain = await connect(engine, 'alice');
    expect(await requestReplay(aliceAgain, undefined, [alice.token])).toEqual(['secret:alice-own']);
    expect(await requestReplay(aliceAgain)).toEqual(['news:top-news']);
  });
});
