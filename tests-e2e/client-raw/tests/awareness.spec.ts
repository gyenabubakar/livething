import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';
import type { WireFrame } from './_ws-rig.ts';

// Raw-wire conformance for awareness against the real server: which message each member
// of a Huddle room is reading. A client sends `__awarenessSet__`; the server answers a joiner
// with `__awarenessSync__` right after `__memberSync__`, and sends `__awareness__` changes to
// every member, the sender included, once per window. The `rooms` family has the option
// (maxBytes 128, a 200 ms window, guests refused by `check`); the `lobby` does not.

const PATH = '/ws/awareness';
const GENERAL = { name: 'room:general', family: 'rooms' };
const RANDOM = { name: 'room:random', family: 'rooms' };
const LOBBY = { name: 'lobby' };
// `ROOM_AWARENESS_MAX_BYTES` in tests-e2e/handlers/awareness/handler.ts.
const MAX_BYTES = 128;

type Channel = { name: string; family?: string };

interface Change {
  connectionId: string;
  memberId?: string;
  meta?: Record<string, unknown>;
  state: { viewingMessageId: string | null } | null;
}

/** One socket of the rig. Every socket of a test lives in the same page. */
interface Member {
  page: Page;
  /** The rig's socket id. */
  socket: string;
  /** The server's connection id, from `__connected__`. */
  connectionId: string;
}

async function openRig(page: Page) {
  await page.goto('/');
  await installRig(page);
}

async function open(page: Page, room: string, username: string): Promise<Member> {
  const socket = await connect(page, { path: PATH, username, room });
  const connected = await waitForFrame(page, socket, {
    match: (f) => f.event === '__connected__',
  });

  return { page, socket, connectionId: connected.payload.connectionId as string };
}

function inChannel(frame: WireFrame, channel: Channel): boolean {
  return frame.metadata?.channel?.name === channel.name;
}

function framesOf(member: Member): Promise<WireFrame[]> {
  return frames(member.page, member.socket);
}

async function join(member: Member, channel: Channel = GENERAL): Promise<WireFrame> {
  await send(member.page, member.socket, {
    event: '__subscribe__',
    payload: null,
    metadata: { channel },
  });

  return waitForFrame(member.page, member.socket, {
    match: (f) => f.event === '__subscribeOk__' && inChannel(f, channel),
  });
}

async function setViewing(
  member: Member,
  state: Record<string, unknown> | null,
  channel: Channel = GENERAL,
) {
  await send(member.page, member.socket, {
    event: '__awarenessSet__',
    payload: { state },
    metadata: { channel },
  });
}

async function changes(member: Member, channel: Channel = GENERAL): Promise<Change[]> {
  return (await framesOf(member))
    .filter((f) => f.event === '__awareness__' && inChannel(f, channel))
    .flatMap((f) => f.payload.changes as Change[]);
}

async function waitForChange(
  member: Member,
  match: (change: Change) => boolean,
  channel: Channel = GENERAL,
): Promise<Change> {
  await expect.poll(async () => (await changes(member, channel)).some(match)).toBe(true);
  return (await changes(member, channel)).find(match)!;
}

/** Every `viewingMessageId` this member got in a change, from any channel, in order. */
async function viewedIn(member: Member): Promise<Array<string | null | undefined>> {
  return (await framesOf(member))
    .filter((f) => f.event === '__awareness__')
    .flatMap((f) => f.payload.changes as Change[])
    .map((c) => c.state?.viewingMessageId);
}

/**
 * Ask the server who is viewing what. The answer comes back on the same socket after every
 * frame the server sent it before, so it is also a barrier for "nothing more arrived".
 */
async function listViewers(member: Member, channel: Channel = GENERAL) {
  const before = (await framesOf(member)).length;
  await send(member.page, member.socket, {
    event: 'list-viewers',
    payload: {},
    metadata: { channel },
  });

  await expect
    .poll(async () => (await framesOf(member)).slice(before).some((f) => f.event === 'viewers'))
    .toBe(true);
  const answer = (await framesOf(member)).slice(before).find((f) => f.event === 'viewers')!;

  return answer.payload.viewers as Array<{
    connectionId: string;
    name: string;
    viewingMessageId: string | null;
  }>;
}

async function waitForRefusal(member: Member, reason: string) {
  return waitForFrame(member.page, member.socket, {
    match: (f) =>
      f.event === '__error__' &&
      f.payload.code === 'awareness-refused' &&
      (f.payload.detail as { reason?: string } | undefined)?.reason === reason,
  });
}

/** Alice and Bob, both in #general. */
async function twoMembers(page: Page, room: string) {
  const alice = await open(page, room, 'alice');
  const bob = await open(page, room, 'bob');
  await join(alice);
  await join(bob);

  return { alice, bob };
}

test.describe('awareness (raw wire)', () => {
  test.beforeEach(async ({ page }) => {
    await openRig(page);
  });

  test('__subscribeOk__ carries awareness.maxBytes only on a channel with the option', async ({
    page,
  }, testInfo) => {
    const alice = await open(page, `aw-${testInfo.testId}`, 'alice');

    const roomAck = await join(alice);
    expect(roomAck.metadata?.channel?.awareness).toEqual({ maxBytes: MAX_BYTES });

    const lobbyAck = await join(alice, LOBBY);
    expect(lobbyAck.metadata?.channel).not.toHaveProperty('awareness');
  });

  test('a joiner gets __awarenessSync__ right after __memberSync__, with every state but its own', async ({
    page,
  }, testInfo) => {
    const room = `aw-${testInfo.testId}`;
    const alice = await open(page, room, 'alice');

    // The first member of an empty room still gets a sync, so its client can set `synced`.
    await join(alice);
    const empty = await waitForFrame(page, alice.socket, {
      match: (f) => f.event === '__awarenessSync__' && inChannel(f, GENERAL),
    });
    expect(empty.payload).toEqual({ entries: [] });

    await setViewing(alice, { viewingMessageId: 'msg-1' });
    await waitForChange(alice, (c) => c.connectionId === alice.connectionId);

    const bob = await open(page, room, 'bob');
    await join(bob);
    const sync = await waitForFrame(page, bob.socket, {
      match: (f) => f.event === '__awarenessSync__' && inChannel(f, GENERAL),
    });

    const order = (await framesOf(bob)).filter((f) => inChannel(f, GENERAL)).map((f) => f.event);
    expect(order.indexOf('__subscribeOk__')).toBeLessThan(order.indexOf('__memberSync__'));
    expect(order.indexOf('__memberSync__') + 1).toBe(order.indexOf('__awarenessSync__'));

    expect(sync.metadata?.channel).toMatchObject(GENERAL);
    expect(sync.payload).toEqual({
      entries: [
        {
          connectionId: alice.connectionId,
          // An ephemeral channel: the member is the connection.
          memberId: alice.connectionId,
          meta: { userId: 'alice', name: 'alice', role: 'member' },
          state: { viewingMessageId: 'msg-1' },
          ageMs: expect.any(Number),
        },
      ],
    });
  });

  test('the first change of an entry carries meta, later changes do not, and the sender gets them too', async ({
    page,
  }, testInfo) => {
    const { alice, bob } = await twoMembers(page, `aw-${testInfo.testId}`);

    await setViewing(alice, { viewingMessageId: 'msg-1' });
    const first = await waitForChange(bob, (c) => c.state?.viewingMessageId === 'msg-1');
    expect(first).toEqual({
      connectionId: alice.connectionId,
      memberId: alice.connectionId,
      meta: { userId: 'alice', name: 'alice', role: 'member' },
      state: { viewingMessageId: 'msg-1' },
    });
    // The sender builds `self` from its own changes.
    await waitForChange(alice, (c) => c.state?.viewingMessageId === 'msg-1');

    await setViewing(alice, { viewingMessageId: 'msg-2' });
    const later = await waitForChange(bob, (c) => c.state?.viewingMessageId === 'msg-2');
    expect(later).toEqual({
      connectionId: alice.connectionId,
      memberId: alice.connectionId,
      state: { viewingMessageId: 'msg-2' },
    });
  });

  test('updates sent inside one window reach members as the newest only', async ({
    page,
  }, testInfo) => {
    const { alice, bob } = await twoMembers(page, `aw-${testInfo.testId}`);

    // Alice scrolls past three messages at once. The first update on a quiet channel goes out
    // at once and opens a 200 ms window; the two after it fall inside that window.
    await page.evaluate(
      ([socket, channel]) => {
        for (const viewingMessageId of ['msg-1', 'msg-2', 'msg-3']) {
          window.__livethingSend!(socket, {
            event: '__awarenessSet__',
            payload: { state: { viewingMessageId } },
            metadata: { channel },
          });
        }
      },
      [alice.socket, GENERAL] as const,
    );

    await waitForChange(bob, (c) => c.state?.viewingMessageId === 'msg-3');
    await listViewers(bob);
    expect(await viewedIn(bob)).toEqual(['msg-1', 'msg-3']);
  });

  test('a state over maxBytes is refused as too-large, with the channel routing', async ({
    page,
  }, testInfo) => {
    const { alice, bob } = await twoMembers(page, `aw-${testInfo.testId}`);

    await setViewing(alice, { viewingMessageId: 'm'.repeat(MAX_BYTES) });
    const refusal = await waitForRefusal(alice, 'too-large');
    expect(refusal.payload.detail).toEqual({ event: '__awarenessSet__', reason: 'too-large' });
    expect(refusal.metadata?.channel).toMatchObject(GENERAL);

    expect(await listViewers(bob)).toEqual([]);
    expect(await changes(bob)).toEqual([]);
  });

  test('a state that fails the schema is refused as invalid', async ({ page }, testInfo) => {
    const { alice, bob } = await twoMembers(page, `aw-${testInfo.testId}`);

    await setViewing(alice, { viewingMessageId: 42 });
    const refusal = await waitForRefusal(alice, 'invalid');
    expect(refusal.payload.detail).toEqual({ event: '__awarenessSet__', reason: 'invalid' });
    expect(refusal.metadata?.channel).toMatchObject(GENERAL);

    expect(await listViewers(bob)).toEqual([]);
    expect(await changes(bob)).toEqual([]);
  });

  test("a guest's state is refused by the room's check", async ({ page }, testInfo) => {
    const room = `aw-${testInfo.testId}`;
    const guest = await open(page, room, 'guest-gina');
    const bob = await open(page, room, 'bob');
    await join(guest);
    await join(bob);

    await setViewing(guest, { viewingMessageId: 'msg-1' });
    const refusal = await waitForRefusal(guest, 'check');
    expect(refusal.payload.detail).toEqual({ event: '__awarenessSet__', reason: 'check' });
    expect(refusal.metadata?.channel).toMatchObject(GENERAL);

    expect(await listViewers(bob)).toEqual([]);
    expect(await changes(bob)).toEqual([]);
  });

  test("a non-member's update is ignored: no refusal, no change", async ({ page }, testInfo) => {
    const room = `aw-${testInfo.testId}`;
    const alice = await open(page, room, 'alice');
    const mallory = await open(page, room, 'mallory');
    await join(alice);

    await setViewing(mallory, { viewingMessageId: 'msg-1' });
    // Frames on one socket are handled in order, so once this lands, so has the update.
    await join(mallory, LOBBY);

    expect((await framesOf(mallory)).filter((f) => f.event === '__error__')).toEqual([]);
    expect(await listViewers(alice)).toEqual([]);
    expect(await changes(alice)).toEqual([]);
  });

  test('a member of a channel without awareness gets unsupported-protocol', async ({
    page,
  }, testInfo) => {
    const alice = await open(page, `aw-${testInfo.testId}`, 'alice');
    await join(alice, LOBBY);

    await setViewing(alice, { viewingMessageId: 'msg-1' }, LOBBY);
    const error = await waitForFrame(page, alice.socket, {
      match: (f) => f.event === '__error__' && f.payload.code === 'unsupported-protocol',
    });
    expect((error.payload.detail as { event?: string }).event).toBe('__awarenessSet__');
  });

  const leaves: Record<string, (alice: Member, bob: Member) => Promise<void>> = {
    unsubscribe: (_alice, bob) =>
      send(bob.page, bob.socket, {
        event: '__unsubscribe__',
        payload: null,
        metadata: { channel: { ...GENERAL, unsubscribeId: 'leave-1' } },
      }),
    kick: (alice) =>
      send(alice.page, alice.socket, {
        event: 'remove-member',
        payload: { userId: 'bob' },
        metadata: { channel: GENERAL },
      }),
    'socket close': (_alice, bob) => closeSocket(bob.page, bob.socket),
  };

  for (const [leave, leaveRoom] of Object.entries(leaves)) {
    test(`a member who leaves by ${leave} is cleared for its peers`, async ({ page }, testInfo) => {
      const { alice, bob } = await twoMembers(page, `aw-${testInfo.testId}`);

      await setViewing(bob, { viewingMessageId: 'msg-1' });
      await waitForChange(alice, (c) => c.connectionId === bob.connectionId);

      await leaveRoom(alice, bob);
      const cleared = await waitForChange(
        alice,
        (c) => c.connectionId === bob.connectionId && c.state === null,
      );
      expect(cleared).toEqual({ connectionId: bob.connectionId, state: null });
      expect(await listViewers(alice)).toEqual([]);
    });
  }

  test('two rooms of one family keep their states apart', async ({ page }, testInfo) => {
    const room = `aw-${testInfo.testId}`;
    const alice = await open(page, room, 'alice');
    const bob = await open(page, room, 'bob');
    const carol = await open(page, room, 'carol');

    // Alice is in both rooms, Bob only in #random, Carol only in #general.
    await join(alice, GENERAL);
    await join(alice, RANDOM);
    await join(bob, RANDOM);
    await join(carol, GENERAL);

    await setViewing(alice, { viewingMessageId: 'general-msg' }, GENERAL);
    await setViewing(alice, { viewingMessageId: 'random-msg' }, RANDOM);
    await waitForChange(carol, (c) => c.state?.viewingMessageId === 'general-msg', GENERAL);
    await waitForChange(bob, (c) => c.state?.viewingMessageId === 'random-msg', RANDOM);

    expect(await listViewers(carol, GENERAL)).toEqual([
      { connectionId: alice.connectionId, name: 'alice', viewingMessageId: 'general-msg' },
    ]);
    expect(await listViewers(bob, RANDOM)).toEqual([
      { connectionId: alice.connectionId, name: 'alice', viewingMessageId: 'random-msg' },
    ]);
    expect(await viewedIn(bob)).toEqual(['random-msg']);
    expect(await viewedIn(carol)).toEqual(['general-msg']);
  });

  test("a server set(id, null) clears a member's state for everyone, that member included", async ({
    page,
  }, testInfo) => {
    const { alice, bob } = await twoMembers(page, `aw-${testInfo.testId}`);

    await setViewing(alice, { viewingMessageId: 'msg-1' });
    await setViewing(bob, { viewingMessageId: 'msg-2' });
    await waitForChange(alice, (c) => c.connectionId === bob.connectionId);
    await waitForChange(bob, (c) => c.connectionId === alice.connectionId);

    await send(page, alice.socket, {
      event: 'hide-viewer',
      payload: { connectionId: bob.connectionId },
      metadata: { channel: GENERAL },
    });

    for (const member of [alice, bob]) {
      const cleared = await waitForChange(
        member,
        (c) => c.connectionId === bob.connectionId && c.state === null,
      );
      expect(cleared).toEqual({ connectionId: bob.connectionId, state: null });
    }

    expect(await listViewers(bob)).toEqual([
      { connectionId: alice.connectionId, name: 'alice', viewingMessageId: 'msg-1' },
    ]);
  });
});
