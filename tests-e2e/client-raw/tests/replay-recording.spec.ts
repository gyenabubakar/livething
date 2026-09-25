import { expect, test } from '@playwright/test';
import type { JSHandle, Page } from '@playwright/test';

interface Received {
  event: string;
  payload: Record<string, unknown> | null;
  metadata?: Record<string, Record<string, unknown>> | null;
}

type Sockets = Record<string, { ws: WebSocket; messages: Received[] }>;

/** One raw socket, opened in the page under `name` (its username). */
interface Peer {
  page: Page;
  sockets: JSHandle<Sockets>;
  name: string;
}

/** Open raw sockets to the replay server, one per username, isolated to one room. */
async function openPeers(page: Page, room: string, usernames: string[]): Promise<Peer[]> {
  const sockets = await page.evaluateHandle(
    async ({ room, usernames }) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const opened: Record<string, { ws: WebSocket; messages: Received[] }> = {};
      for (const username of usernames) {
        opened[username] = await new Promise((resolve, reject) => {
          const ws = new WebSocket(
            `${proto}//${location.host}/ws/replay?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
          );
          const messages: Received[] = [];
          ws.onmessage = (ev) => {
            if (typeof ev.data === 'string') messages.push(window.__livethingDecode(ev.data));
          };
          ws.onopen = () => resolve({ ws, messages });
          ws.onerror = (e) => reject(e);
        });
      }

      return opened;
    },
    { room, usernames },
  );

  return usernames.map((name) => ({ page, sockets, name }));
}

function send(peer: Peer, frame: unknown) {
  return peer.page.evaluate(
    ({ sockets, name, frame }) => sockets[name]!.ws.send(window.__livethingEncode(frame)),
    { sockets: peer.sockets, name: peer.name, frame },
  );
}

function messages(peer: Peer): Promise<Received[]> {
  return peer.page.evaluate(({ sockets, name }) => sockets[name]!.messages.slice(), {
    sockets: peer.sockets,
    name: peer.name,
  });
}

/** Ask for the full replay of one scope and return the `text` of every replayed frame. */
async function replayTexts(peer: Peer, channel?: string): Promise<string[]> {
  const before = (await messages(peer)).length;
  await send(peer, {
    event: '__replay__',
    payload: { lastKnownSeq: 0 },
    metadata: channel ? { channel: { name: channel } } : null,
  });
  // A replay answer has no end marker, so wait a beat for every row to arrive.
  await peer.page.waitForTimeout(400);

  return (await messages(peer))
    .slice(before)
    .filter((m) => !m.event.startsWith('__'))
    .map((m) => String(m.payload?.text));
}

async function subscribeRoom(peer: Peer) {
  await send(peer, {
    event: '__subscribe__',
    payload: null,
    metadata: { channel: { name: 'replay-room' } },
  });
  await expect
    .poll(async () => (await messages(peer)).some((m) => m.event === '__subscribeOk__'))
    .toBe(true);
}

test.describe('replay records only frames addressed to the requester', () => {
  test('a private send and a message to another user never replay to the wrong connection', async ({
    page,
  }, testInfo) => {
    const room = `recording-private-${testInfo.testId}`;
    await page.goto(`/replay?room=${room}`);
    const [alice] = await openPeers(page, room, ['alice']);

    await send(alice!, { event: 'send-private', payload: { text: 'alice-only' } });
    await send(alice!, { event: 'send-to-user', payload: { userId: 'bob', text: 'for-bob' } });
    await expect
      .poll(async () => (await messages(alice!)).some((m) => m.payload?.text === 'alice-only'))
      .toBe(true);

    const [bob, carol] = await openPeers(page, room, ['bob', 'carol']);
    expect(await replayTexts(bob!)).toEqual(['for-bob']);
    expect(await replayTexts(carol!)).toEqual([]);
  });
});

test.describe('replay records a broadcast that reaches nobody live', () => {
  test('a top-level broadcast and a channel broadcast from a lone sender replay to a later client', async ({
    page,
  }, testInfo) => {
    const room = `recording-lonely-${testInfo.testId}`;
    await page.goto(`/replay?room=${room}`);
    const [alice] = await openPeers(page, room, ['alice']);

    await subscribeRoom(alice!);
    await send(alice!, { event: 'shout', payload: { text: 'top-nobody-live' } });
    await send(alice!, {
      event: 'shout-room',
      payload: { text: 'room-nobody-live' },
      metadata: { channel: { name: 'replay-room' } },
    });
    // Alice is excluded from her own broadcasts, and no one else is connected.
    await page.waitForTimeout(200);
    const aliceTexts = (await messages(alice!)).map((m) => m.payload?.text);
    expect(aliceTexts).not.toContain('top-nobody-live');
    expect(aliceTexts).not.toContain('room-nobody-live');

    const [bob] = await openPeers(page, room, ['bob']);
    expect(await replayTexts(bob!)).toEqual(['top-nobody-live']);

    await subscribeRoom(bob!);
    expect(await replayTexts(bob!, 'replay-room')).toEqual(['room-nobody-live']);
  });
});
