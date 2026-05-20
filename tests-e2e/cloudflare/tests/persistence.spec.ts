import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type WireFrame = {
  event: string;
  payload: Record<string, unknown>;
  __wskit?: Record<string, unknown>;
};

declare global {
  interface Window {
    __wsConnect?: (username: string, room: string) => Promise<{ id: string; frames: WireFrame[] }>;
    __wsSend?: (id: string, frame: WireFrame) => void;
    __wsClose?: (id: string) => void;
    __wsFrames?: (id: string) => WireFrame[];
  }
}

async function installRig(page: Page) {
  await page.evaluate(() => {
    const sockets = new Map<string, WebSocket>();
    const frames = new Map<string, WireFrame[]>();
    let nextId = 1;

    window.__wsConnect = (username, room) => {
      const id = `s${nextId++}`;
      const url = `${location.origin.replace(/^http/, 'ws')}/ws/persistence?room=${encodeURIComponent(
        room,
      )}&username=${encodeURIComponent(username)}`;
      const ws = new WebSocket(url);
      sockets.set(id, ws);
      frames.set(id, []);
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') {
          try {
            frames.get(id)!.push(JSON.parse(ev.data));
          } catch {
            // ignore
          }
        }
      });
      return new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve({ id, frames: frames.get(id)! }));
        ws.addEventListener('error', () => reject(new Error('ws error')));
      });
    };

    window.__wsSend = (id, frame) => {
      sockets.get(id)?.send(JSON.stringify(frame));
    };

    window.__wsClose = (id) => {
      sockets.get(id)?.close();
    };

    window.__wsFrames = (id) => frames.get(id) ?? [];
  });
}

async function connect(page: Page, username: string, room: string): Promise<string> {
  const result = await page.evaluate(
    ([u, r]) => window.__wsConnect!(u, r).then((res) => res.id),
    [username, room],
  );
  return result;
}

async function send(page: Page, id: string, frame: WireFrame) {
  await page.evaluate(([sid, f]) => window.__wsSend!(sid, f as WireFrame), [id, frame] as const);
}

async function close(page: Page, id: string) {
  await page.evaluate((sid) => window.__wsClose!(sid), id);
}

async function frames(page: Page, id: string): Promise<WireFrame[]> {
  return page.evaluate((sid) => window.__wsFrames!(sid), id);
}

async function waitForFrame(
  page: Page,
  id: string,
  match: (f: WireFrame) => boolean,
  timeoutMs = 2000,
): Promise<WireFrame> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const all = await frames(page, id);
    const found = all.find(match);
    if (found) return found;
    await page.waitForTimeout(50);
  }
  throw new Error('frame not received in time');
}

test.describe('persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await installRig(page);
  });

  test('persistent channel auto-rejoins on reconnect with _memberOnline (no _memberJoin to existing peers)', async ({
    page,
  }, testInfo) => {
    const room = `persist-rejoin-${testInfo.testId}`;

    // Alice opens, subscribes to archive-room, then disconnects.
    const alice1 = await connect(page, 'alice', room);
    await send(page, alice1, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'archive-room' },
    });
    await waitForFrame(page, alice1, (f) => f.event === '__subscribeOk__');
    await close(page, alice1);
    await page.waitForTimeout(150);

    // Bob is now in the channel as a witness.
    const bob = await connect(page, 'bob', room);
    await send(page, bob, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'archive-room' },
    });
    await waitForFrame(page, bob, (f) => f.event === '__subscribeOk__');

    // Alice reconnects — engine auto-rejoins her into archive-room.
    const alice2 = await connect(page, 'alice', room);

    // Bob must see __memberOnline__ (Alice's new socket) but NOT __memberJoin__ —
    // Alice was already a member of the group, only her presence changed.
    const onlineFrame = await waitForFrame(
      page,
      bob,
      (f) => f.event === '__memberOnline__' && f.__wskit?.channel === 'archive-room',
    );
    expect(onlineFrame.__wskit?.channel).toBe('archive-room');

    const bobFrames = await frames(page, bob);
    // Bob may have seen ONE __memberJoin__ (his own initial sync from
    // existing members). What matters: there is NOT a __memberJoin__ frame
    // specifically for Alice's new socket. The __memberOnline__ frame for
    // Alice should not be preceded by a matching __memberJoin__.
    const memberJoinIdx = bobFrames.findIndex(
      (f) =>
        f.event === '__memberJoin__' &&
        f.__wskit?.channel === 'archive-room' &&
        f.payload.connectionId === onlineFrame.payload.connectionId,
    );
    expect(memberJoinIdx).toBe(-1);

    // Alice's new socket should NOT need to send __subscribe__ — broadcasts
    // to archive-room still reach her.
    await send(page, bob, {
      event: 'send-message',
      payload: { text: 'hello rejoined alice' },
      __wskit: { channel: 'archive-room' },
    });
    const echoToAlice = await waitForFrame(
      page,
      alice2,
      (f) => f.event === 'room-message' && f.payload.text === 'hello rejoined alice',
    );
    expect(echoToAlice.payload.from).toBe('bob');
  });

  test('.persistent(false) channel does NOT auto-rejoin on reconnect', async ({
    page,
  }, testInfo) => {
    const room = `persist-ephemeral-${testInfo.testId}`;

    const alice1 = await connect(page, 'alice', room);
    await send(page, alice1, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'typing-indicator' },
    });
    await waitForFrame(page, alice1, (f) => f.event === '__subscribeOk__');
    await close(page, alice1);
    await page.waitForTimeout(150);

    const alice2 = await connect(page, 'alice', room);
    // Give the engine a moment to do whatever it would do on connect.
    await page.waitForTimeout(300);
    const alice2Frames = await frames(page, alice2);
    // No __subscribeOk__ for typing-indicator should appear because the
    // channel is opt-out persistent.
    const rejoined = alice2Frames.find(
      (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'typing-indicator',
    );
    expect(rejoined).toBeUndefined();
  });

  test('removeMember drops the durable row and kicks the live socket', async ({
    page,
  }, testInfo) => {
    const room = `persist-removemember-${testInfo.testId}`;

    const alice1 = await connect(page, 'alice', room);
    await send(page, alice1, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'archive-room' },
    });
    await waitForFrame(page, alice1, (f) => f.event === '__subscribeOk__');

    const admin = await connect(page, 'admin', room);
    await send(page, admin, {
      event: 'remove-member',
      payload: { identity: 'alice' },
    });

    // Alice gets a true-leave signal forwarded by the onUnsubscribe hook.
    const trueLeave = await waitForFrame(page, alice1, (f) => f.event === 'true-leave');
    expect(trueLeave.payload.channel).toBe('archive-room');
    expect(trueLeave.payload.username).toBe('alice');

    await close(page, alice1);
    await page.waitForTimeout(150);

    // Alice reconnects — auto-rejoin must NOT bring her back into the
    // channel because removeMember dropped her durable row.
    const alice2 = await connect(page, 'alice', room);
    await page.waitForTimeout(300);
    const alice2Frames = await frames(page, alice2);
    const rejoinedSubscribeOk = alice2Frames.find(
      (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'archive-room',
    );
    expect(rejoinedSubscribeOk).toBeUndefined();
  });

  test('plain disconnect on persistent channel broadcasts _memberOffline but NOT _memberLeave', async ({
    page,
  }, testInfo) => {
    const room = `persist-disconnect-${testInfo.testId}`;

    const alice1 = await connect(page, 'alice', room);
    await send(page, alice1, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'archive-room' },
    });
    await waitForFrame(page, alice1, (f) => f.event === '__subscribeOk__');

    const bob = await connect(page, 'bob', room);
    await send(page, bob, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'archive-room' },
    });
    await waitForFrame(page, bob, (f) => f.event === '__subscribeOk__');

    // Bob clears his frame log mark by capturing length before close.
    const beforeLen = (await frames(page, bob)).length;

    await close(page, alice1);
    await page.waitForTimeout(300);

    const after = (await frames(page, bob)).slice(beforeLen);
    const offline = after.find(
      (f) => f.event === '__memberOffline__' && f.__wskit?.channel === 'archive-room',
    );
    expect(offline).toBeTruthy();

    const leave = after.find(
      (f) => f.event === '__memberLeave__' && f.__wskit?.channel === 'archive-room',
    );
    expect(leave).toBeUndefined();
  });
});
