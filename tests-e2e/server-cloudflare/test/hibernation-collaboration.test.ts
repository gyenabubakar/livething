import { encodeBinaryFrame, splitBinaryFrame } from '@livething/core';
import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import * as Y from 'yjs';

// The Collaboration plugin on a hibernating Durable Object. The loaded doc lives in memory, so
// a wake loads it again from the object's SQL storage, and a member's access lives in its
// hibernation row, so a member who joined before the sleep can edit after it.

const PREFIX = '__livething:collaboration::';
const LAUNCH = { name: 'task-board:launch', family: `${PREFIX}docs` };

interface Frame {
  readonly event: string;
  readonly info: Record<string, unknown> | null;
  readonly bytes?: Uint8Array;
}

async function open(stub: DurableObjectStub, username: string) {
  const response = (await stub.fetch(`https://huddle.test/?username=${username}`, {
    headers: { Upgrade: 'websocket' },
  })) as Response & { webSocket: WebSocket };
  const socket = response.webSocket;
  socket.binaryType = 'arraybuffer';
  socket.accept();

  const frames: Frame[] = [];
  const ydoc = new Y.Doc();
  socket.addEventListener('message', ({ data }) => {
    if (typeof data === 'string') {
      const [event, info] = JSON.parse(data);
      frames.push({ event, info });
      return;
    }

    const split = splitBinaryFrame(data as ArrayBuffer);
    if (split.kind !== 'frame') throw new Error('a broken binary frame');

    const [event, info] = JSON.parse(split.envelope);
    frames.push({ event: event.replace(PREFIX, ''), info, bytes: split.bytes.slice() });
    if (event === `${PREFIX}update`) Y.applyUpdate(ydoc, split.bytes, 'server');
  });

  await waitFor(frames, (frame) => frame.event === '__connected__');

  return { socket, frames, ydoc, sent: 0 };
}

type Member = Awaited<ReturnType<typeof open>>;

async function waitFor(frames: Frame[], match: (frame: Frame) => boolean): Promise<Frame> {
  for (let tries = 0; tries < 300; tries += 1) {
    const frame = frames.find(match);
    if (frame) return frame;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`no matching frame; got ${JSON.stringify(frames.map((f) => f.event))}`);
}

/** Join the board and sync it. */
async function join(member: Member): Promise<void> {
  member.socket.send(JSON.stringify(['__subscribe__', null, { channel: LAUNCH }]));
  await waitFor(member.frames, (frame) => frame.event === '__subscribeOk__');

  member.socket.send(
    encodeBinaryFrame(
      JSON.stringify([
        `${PREFIX}sync`,
        null,
        { channel: LAUNCH, exchange: { id: 'sync-1', source: 'client' } },
      ]),
      Y.encodeStateVector(member.ydoc),
    ),
  );
  await waitFor(member.frames, (frame) => frame.event === 'sync');
}

/** Rename the board on `member`'s copy and send the update. */
async function rename(member: Member, title: string): Promise<number> {
  const before = Y.encodeStateVector(member.ydoc);
  const text = member.ydoc.getText('title');
  member.ydoc.transact(() => {
    text.delete(0, text.length);
    text.insert(0, title);
  });
  member.sent += 1;
  member.socket.send(
    encodeBinaryFrame(
      JSON.stringify([`${PREFIX}update`, { n: member.sent }, { channel: LAUNCH }]),
      Y.encodeStateAsUpdate(member.ydoc, before),
    ),
  );

  return member.sent;
}

it('keeps editing a board across a hibernation wake', async () => {
  const stub = env.COLLABORATION_HIBERNATION_SERVER.get(
    env.COLLABORATION_HIBERNATION_SERVER.idFromName('collaboration-wake'),
  );
  const alice = await open(stub, 'alice');
  const bob = await open(stub, 'bob');
  await join(alice);
  await join(bob);

  const first = await rename(alice, 'Launch');
  await waitFor(alice.frames, (frame) => frame.event === 'ack' && frame.info?.n === first);
  await waitFor(bob.frames, () => bob.ydoc.getText('title').toString() === 'Launch');

  await evictDurableObject(stub);

  // Alice joined before the sleep: her access is still known, and the doc loads again.
  const second = await rename(alice, 'Launch plan');
  await waitFor(alice.frames, (frame) => frame.event === 'ack' && frame.info?.n === second);
  await waitFor(bob.frames, () => bob.ydoc.getText('title').toString() === 'Launch plan');

  const carol = await open(stub, 'carol');
  await join(carol);
  expect(carol.ydoc.getText('title').toString()).toBe('Launch plan');
  expect(alice.frames.filter((frame) => frame.event === 'refused')).toEqual([]);
});
