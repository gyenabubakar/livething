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
): Promise<WireFrame> {
  const timeoutMs = 2000;
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
    // Bob's own initial sync arrives as __memberSync__, not __memberJoin__.
    // What matters: there is NOT a __memberJoin__ frame specifically for
    // Alice's new socket. The __memberOnline__ frame for Alice should not
    // be preceded by a matching __memberJoin__.
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

  test('auto-rejoin sends __subscribeOk__ with source "server"', async ({ page }, testInfo) => {
    const room = `persist-source-${testInfo.testId}`;

    // First connect: subscribe so alice has a durable membership row.
    const alice1 = await connect(page, 'alice', room);
    await send(page, alice1, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'archive-room' },
    });
    await waitForFrame(
      page,
      alice1,
      (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'archive-room',
    );
    await close(page, alice1);
    await page.waitForTimeout(200);

    // Reconnect: the engine auto-rejoins alice and the __subscribeOk__ it sends
    // is unsolicited, so source must be 'server' (not 'client').
    const alice2 = await connect(page, 'alice', room);
    const ok = await waitForFrame(
      page,
      alice2,
      (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'archive-room',
    );
    expect(ok.payload.source).toBe('server');
  });

  test('plain disconnect fires onSessionEnd (session-ended) but NOT onUnsubscribe (true-leave)', async ({
    page,
  }, testInfo) => {
    const room = `persist-sessionend-${testInfo.testId}`;

    const alice = await connect(page, 'alice', room);
    const bob = await connect(page, 'bob', room);
    for (const c of [alice, bob]) {
      await send(page, c, {
        event: '__subscribe__',
        payload: {},
        __wskit: { channel: 'archive-room' },
      });
      await waitForFrame(
        page,
        c,
        (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'archive-room',
      );
    }

    const beforeLen = (await frames(page, bob)).length;
    await close(page, alice);
    await page.waitForTimeout(400);

    const after = (await frames(page, bob)).slice(beforeLen);
    const sessionEnded = after.find(
      (f) => f.event === 'session-ended' && f.__wskit?.channel === 'archive-room',
    );
    expect(sessionEnded).toBeTruthy();
    expect(sessionEnded!.payload.username).toBe('alice');

    // true-leave is reserved for explicit unsubscribe/removeMember, not a drop.
    expect(after.find((f) => f.event === 'true-leave')).toBeUndefined();
  });

  test('removeMember fires onUnsubscribe (true-leave) but NOT onSessionEnd (session-ended)', async ({
    page,
  }, testInfo) => {
    const room = `persist-removeonly-${testInfo.testId}`;

    const alice = await connect(page, 'alice', room);
    const admin = await connect(page, 'admin', room);
    await send(page, alice, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'archive-room' },
    });
    await waitForFrame(
      page,
      alice,
      (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'archive-room',
    );

    const beforeLen = (await frames(page, alice)).length;
    await send(page, admin, { event: 'remove-member', payload: { identity: 'alice' } });

    // true-leave fires while alice is still connected.
    await waitForFrame(
      page,
      alice,
      (f) => f.event === 'true-leave' && f.payload.channel === 'archive-room',
    );

    await page.waitForTimeout(200);
    const after = (await frames(page, alice)).slice(beforeLen);
    // onSessionEnd must NOT fire — alice was removed from the channel, not disconnected.
    expect(after.filter((f) => f.event === 'session-ended')).toHaveLength(0);
  });

  test('auto-rejoin re-runs the channel check; a now-failing check prevents rejoin', async ({
    page,
  }, testInfo) => {
    const room = `persist-rejoincheck-${testInfo.testId}`;

    const alice1 = await connect(page, 'alice', room);
    await send(page, alice1, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'archive-room' },
    });
    await waitForFrame(
      page,
      alice1,
      (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'archive-room',
    );

    // An admin bans alice; the ban is durable, so it is visible when alice's
    // auto-rejoin re-runs the channel check on reconnect.
    const admin = await connect(page, 'admin', room);
    await send(page, admin, { event: 'ban', payload: { identity: 'alice' } });
    await page.waitForTimeout(150);

    await close(page, alice1);
    await page.waitForTimeout(200);

    // Alice reconnects. Auto-rejoin re-runs the check, which now throws, so she
    // is NOT brought back into the channel — no __subscribeOk__ arrives.
    const alice2 = await connect(page, 'alice', room);
    await page.waitForTimeout(400);
    const rejoined = (await frames(page, alice2)).find(
      (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'archive-room',
    );
    expect(rejoined).toBeUndefined();
  });

  test('anonymous connection does NOT auto-rejoin on reconnect (no durable membership row)', async ({
    page,
  }, testInfo) => {
    // Anonymous upgrade (`&anon`, no username) yields an empty identity. The
    // engine keys durable membership rows by identity, so an empty-identity
    // subscribe writes NO durable row — there is nothing to auto-rejoin from on
    // reconnect. Mirrors 'removeMember … no auto-rejoin': subscribe, get
    // __subscribeOk__, drop, reconnect, and assert no rejoin __subscribeOk__.
    //
    // Inline raw WebSocket via page.evaluate because the shared local rig
    // hardcodes a username-only URL with no `&anon` support.
    const room = `persist-anon-${testInfo.testId}`;

    function connectAnon(id: string) {
      return page.evaluate(
        ([sid, r]) => {
          const url = `${location.origin.replace(/^http/, 'ws')}/ws/persistence?room=${encodeURIComponent(
            r,
          )}&anon`;
          const ws = new WebSocket(url);
          const w = window as unknown as {
            __anon?: Map<string, { ws: WebSocket; frames: WireFrame[] }>;
          };
          w.__anon ??= new Map();
          const frames: WireFrame[] = [];
          w.__anon.set(sid, { ws, frames });
          ws.addEventListener('message', (ev) => {
            if (typeof ev.data === 'string') {
              try {
                frames.push(JSON.parse(ev.data));
              } catch {
                // ignore
              }
            }
          });
          return new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => resolve());
            ws.addEventListener('error', () => reject(new Error('ws error')));
          });
        },
        [id, room] as const,
      );
    }

    function sendAnon(id: string, frame: WireFrame) {
      return page.evaluate(
        ([sid, f]) => {
          const w = window as unknown as {
            __anon?: Map<string, { ws: WebSocket; frames: WireFrame[] }>;
          };
          w.__anon?.get(sid)?.ws.send(JSON.stringify(f as WireFrame));
        },
        [id, frame] as const,
      );
    }

    function closeAnon(id: string) {
      return page.evaluate((sid) => {
        const w = window as unknown as {
          __anon?: Map<string, { ws: WebSocket; frames: WireFrame[] }>;
        };
        w.__anon?.get(sid)?.ws.close();
      }, id);
    }

    function framesAnon(id: string) {
      return page.evaluate((sid) => {
        const w = window as unknown as {
          __anon?: Map<string, { ws: WebSocket; frames: WireFrame[] }>;
        };
        return w.__anon?.get(sid)?.frames ?? [];
      }, id);
    }

    // First anonymous connection: manually subscribe to the persistent channel.
    await connectAnon('a1');
    await sendAnon('a1', {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'archive-room' },
    });
    // The channel check (ban:<empty>) passes for an empty identity, so the
    // manual subscribe still returns __subscribeOk__.
    const start = Date.now();
    let subscribed = false;
    while (Date.now() - start < 2000) {
      const all = await framesAnon('a1');
      if (all.some((f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'archive-room')) {
        subscribed = true;
        break;
      }
      await page.waitForTimeout(50);
    }
    expect(subscribed).toBe(true);

    await closeAnon('a1');
    await page.waitForTimeout(150);

    // Reconnect anonymously. With no durable row, the engine has nothing to
    // auto-rejoin, so no __subscribeOk__ for archive-room should arrive.
    await connectAnon('a2');
    await page.waitForTimeout(400);
    const a2Frames = await framesAnon('a2');
    const rejoined = a2Frames.find(
      (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'archive-room',
    );
    expect(rejoined).toBeUndefined();
  });

  test('presence frames carry member meta', async ({ page }, testInfo) => {
    const room = `persist-meta-${testInfo.testId}`;

    const alice = await connect(page, 'alice', room);
    await send(page, alice, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'archive-room' },
    });
    await waitForFrame(page, alice, (f) => f.event === '__subscribeOk__');

    // Bob joins after alice, so bob's initial __memberSync__ lists alice with
    // her meta (the { username } set by the upgrade).
    const bob = await connect(page, 'bob', room);
    await send(page, bob, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'archive-room' },
    });
    const sync = await waitForFrame(
      page,
      bob,
      (f) => f.event === '__memberSync__' && f.__wskit?.channel === 'archive-room',
    );
    const members = sync.payload.members as { connectionId: string; meta: { username?: string } }[];
    expect(members.some((m) => m.meta?.username === 'alice')).toBe(true);
  });
});
