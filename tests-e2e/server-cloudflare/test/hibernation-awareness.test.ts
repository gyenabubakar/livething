import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

// Awareness on a hibernating Durable Object. Each connection's states are written to its
// hibernation row 5 s after a change, and an evicted object rebuilds them on wake:
// a member who joins after the wake gets them in its sync, and peers who saw an entry
// before the sleep get its later changes without `meta` again.

interface Frame {
  event: string;
  payload: Record<string, unknown>;
  metadata: { channel?: { name?: string } } | null;
}

interface Change {
  connectionId: string;
  meta?: Record<string, unknown>;
  state: { viewingMessageId: string | null } | null;
}

const GENERAL = { name: 'room:general', family: 'rooms' };

async function open(stub: DurableObjectStub, username: string) {
  const response = (await stub.fetch(`https://huddle.test/?username=${username}`, {
    headers: { Upgrade: 'websocket' },
  })) as Response & { webSocket: WebSocket };
  const socket = response.webSocket;
  socket.accept();

  const frames: Frame[] = [];
  socket.addEventListener('message', ({ data }) => {
    const [event, payload, metadata] = JSON.parse(String(data));
    frames.push({ event, payload, metadata });
  });

  const connected = await waitFor(frames, (frame) => frame.event === '__connected__');

  return { socket, frames, connectionId: connected.payload.connectionId as string };
}

async function waitFor(frames: Frame[], match: (frame: Frame) => boolean): Promise<Frame> {
  for (let tries = 0; tries < 300; tries += 1) {
    const frame = frames.find(match);
    if (frame) return frame;

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`no matching frame; got ${JSON.stringify(frames)}`);
}

function send(socket: WebSocket, event: string, payload: unknown): void {
  socket.send(JSON.stringify([event, payload, { channel: GENERAL }]));
}

async function join(member: Awaited<ReturnType<typeof open>>) {
  send(member.socket, '__subscribe__', null);
  await waitFor(member.frames, (frame) => frame.event === '__awarenessSync__');
}

function changes(frames: Frame[]): Change[] {
  return frames
    .filter((frame) => frame.event === '__awareness__')
    .flatMap((frame) => frame.payload.changes as Change[]);
}

async function waitForChange(frames: Frame[], match: (change: Change) => boolean) {
  await waitFor(frames, (frame) => changes([frame]).some(match));
  return changes(frames).find(match)!;
}

it('keeps awareness states across a hibernation wake', async () => {
  const stub = env.AWARENESS_HIBERNATION_SERVER.get(
    env.AWARENESS_HIBERNATION_SERVER.idFromName('awareness-wake'),
  );
  const alice = await open(stub, 'alice');
  const bob = await open(stub, 'bob');
  await join(alice);
  await join(bob);

  send(alice.socket, '__awarenessSet__', { state: { viewingMessageId: 'msg-1' } });
  await waitForChange(bob.frames, (change) => change.state?.viewingMessageId === 'msg-1');

  // The row is not written yet. Its pending write timer keeps the object up, so the eviction,
  // like a real hibernation, waits for the write (about 5 s) before the object sleeps.
  await evictDurableObject(stub);

  // A member who joins after the wake gets the state from before it.
  const carol = await open(stub, 'carol');
  await join(carol);
  const sync = carol.frames.find((frame) => frame.event === '__awarenessSync__')!;
  expect(sync.payload.entries).toEqual([
    {
      connectionId: alice.connectionId,
      memberId: alice.connectionId,
      meta: { userId: 'alice', name: 'alice', role: 'member' },
      state: { viewingMessageId: 'msg-1' },
      ageMs: expect.any(Number),
    },
  ]);

  // Handlers see it too.
  send(bob.socket, 'list-viewers', {});
  const answer = await waitFor(bob.frames, (frame) => frame.event === 'viewers');
  expect(answer.payload.viewers).toEqual([
    { connectionId: alice.connectionId, name: 'alice', viewingMessageId: 'msg-1' },
  ]);

  // Bob saw alice's entry before the sleep, so her next change comes without `meta`.
  send(alice.socket, '__awarenessSet__', { state: { viewingMessageId: 'msg-2' } });
  const next = await waitForChange(
    bob.frames,
    (change) => change.state?.viewingMessageId === 'msg-2',
  );
  expect(next).toEqual({
    connectionId: alice.connectionId,
    memberId: alice.connectionId,
    state: { viewingMessageId: 'msg-2' },
  });
});
