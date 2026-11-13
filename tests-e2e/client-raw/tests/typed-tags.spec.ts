import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type WireFrame = {
  event: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, Record<string, unknown>> | null;
};

type WireInput = Omit<WireFrame, 'payload'> & { payload: Record<string, unknown> | null };

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
      const url = `${location.origin.replace(/^http/, 'ws')}/ws/typed-tags?room=${encodeURIComponent(
        room,
      )}&username=${encodeURIComponent(username)}`;
      const ws = new WebSocket(url);
      sockets.set(id, ws);
      frames.set(id, []);

      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') {
          try {
            frames.get(id)!.push(window.__livethingDecode(ev.data));
          } catch {
            /* ignore */
          }
        }
      });

      return new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve({ id, frames: frames.get(id)! }));
        ws.addEventListener('error', () => reject(new Error('ws error')));
      });
    };

    window.__wsSend = (id, frame) => {
      sockets.get(id)?.send(window.__livethingEncode(frame));
    };
    window.__wsClose = (id) => sockets.get(id)?.close();
    window.__wsFrames = (id) => frames.get(id) ?? [];
  });
}

async function connect(page: Page, username: string, room: string): Promise<string> {
  return page.evaluate(
    ([u, r]) => window.__wsConnect!(u, r).then((res) => res.id),
    [username, room],
  );
}

async function send(page: Page, id: string, frame: WireInput) {
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

// Waits for a frame that arrived after `beforeLen`, so a retried trigger sees
// its own new response instead of a stale one from an earlier attempt.
async function waitForFreshFrame(
  page: Page,
  opts: { id: string; beforeLen: number; match: (f: WireFrame) => boolean; timeoutMs?: number },
): Promise<WireFrame> {
  const { id, beforeLen, match, timeoutMs = 800 } = opts;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = (await frames(page, id)).slice(beforeLen).find(match);
    if (found) return found;

    await page.waitForTimeout(50);
  }

  throw new Error('frame not received in time');
}

// Sends a request frame and waits for the freshest reply after it (not just
// the first-ever match, so a retried query sees its own new response instead
// of a stale one from an earlier attempt).
async function queryFresh(
  page: Page,
  opts: { id: string; request: WireInput; match: (f: WireFrame) => boolean },
): Promise<WireFrame> {
  const { id, request, match } = opts;
  const beforeLen = (await frames(page, id)).length;
  await send(page, id, request);
  return waitForFreshFrame(page, { id, beforeLen, match, timeoutMs: 2000 });
}

test.describe('typed tags', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await installRig(page);
  });

  test('authenticate helper attaches an ephemeral user ref via requireUsername', async ({
    page,
  }, testInfo) => {
    const room = `tt-authenticate-${testInfo.testId}`;
    const c = await connect(page, 'alice', room);
    await send(page, c, { event: 'list-my-tags', payload: {} });
    const list = await waitForFrame(page, c, (f) => f.event === 'tags-list');
    expect(list.payload.tags).toEqual([{ kind: 'ephemeral', group: 'user', key: 'alice' }]);
  });

  test('ephemeral add + remove via ctx.tags.ephemeral roundtrip in list', async ({
    page,
  }, testInfo) => {
    const room = `tt-eph-${testInfo.testId}`;
    const c = await connect(page, 'alice', room);
    await send(page, c, {
      event: 'add-tag',
      payload: { kind: 'ephemeral', group: 'role', key: 'admin' },
    });
    await page.waitForTimeout(100);
    await send(page, c, { event: 'list-my-tags', payload: {} });

    const list = await waitForFrame(page, c, (f) => f.event === 'tags-list');
    const tagList = list.payload.tags as { kind: string; group: string; key: string }[];
    expect(tagList).toContainEqual({ kind: 'ephemeral', group: 'role', key: 'admin' });
    expect(tagList).toContainEqual({ kind: 'ephemeral', group: 'user', key: 'alice' });
  });

  test('persistent tag survives disconnect and is restored on reconnect', async ({
    page,
  }, testInfo) => {
    const room = `tt-persist-${testInfo.testId}`;
    const c1 = await connect(page, 'alice', room);
    await send(page, c1, {
      event: 'add-tag',
      payload: { kind: 'persistent', group: 'favorite', key: 'room-42' },
    });
    await close(page, c1);

    const c2 = await connect(page, 'alice', room);
    // The persistent write may not have landed the instant close() runs, so
    // retry the list query instead of trusting a single fixed delay.
    await expect(async () => {
      const list = await queryFresh(page, {
        id: c2,
        request: { event: 'list-my-tags', payload: {} },
        match: (f) => f.event === 'tags-list',
      });
      expect(list.payload.tags).toContainEqual({
        kind: 'persistent',
        group: 'favorite',
        key: 'room-42',
      });
    }).toPass({ timeout: 10_000 });
  });

  test('tag fan-out reaches every connection with the matching ref', async ({ page }, testInfo) => {
    const room = `tt-fanout-${testInfo.testId}`;
    const alice = await connect(page, 'alice', room);
    const bob = await connect(page, 'bob', room);
    await send(page, alice, {
      event: 'add-tag',
      payload: { kind: 'ephemeral', group: 'role', key: 'admin' },
    });
    await send(page, bob, {
      event: 'add-tag',
      payload: { kind: 'ephemeral', group: 'role', key: 'admin' },
    });

    const carol = await connect(page, 'carol', room);

    // Alice's and bob's add-tag are on separate connections with no
    // ordering guarantee against carol's fan-out trigger, so retry the
    // trigger itself until both have a fresh echo.
    let aliceEcho!: WireFrame;
    let bobEcho!: WireFrame;
    await expect(async () => {
      const aliceBefore = (await frames(page, alice)).length;
      const bobBefore = (await frames(page, bob)).length;
      await send(page, carol, {
        event: 'fan-out-to-tag',
        payload: { group: 'role', key: 'admin', text: 'hi admins' },
      });
      aliceEcho = await waitForFreshFrame(page, {
        id: alice,
        beforeLen: aliceBefore,
        match: (f) => f.event === 'fan-out-echo',
      });
      bobEcho = await waitForFreshFrame(page, {
        id: bob,
        beforeLen: bobBefore,
        match: (f) => f.event === 'fan-out-echo',
      });
    }).toPass({ timeout: 10_000 });
    expect(aliceEcho.payload.text).toBe('hi admins');
    expect(bobEcho.payload.text).toBe('hi admins');

    // Negative check: give a wrong echo to carol time to arrive.
    await page.waitForTimeout(150);
    const carolFrames = await frames(page, carol);
    const carolEcho = carolFrames.find((f) => f.event === 'fan-out-echo');
    expect(carolEcho).toBeUndefined();
  });

  test('kick by tag ref drops every matching socket from the channel', async ({
    page,
  }, testInfo) => {
    const room = `tt-kick-${testInfo.testId}`;
    const alice = await connect(page, 'alice', room);
    const bob = await connect(page, 'bob', room);

    await send(page, alice, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'room' } },
    });
    await send(page, bob, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'room' } },
    });
    await waitForFrame(page, alice, (f) => f.event === '__subscribeOk__');
    await waitForFrame(page, bob, (f) => f.event === '__subscribeOk__');

    await send(page, alice, {
      event: 'add-tag',
      payload: { kind: 'ephemeral', group: 'role', key: 'troll' },
    });
    // Confirm the tag landed via alice's own connection (message order on a
    // connection guarantees this reflects the add-tag above) before
    // triggering the kick from a separate admin connection.
    await queryFresh(page, {
      id: alice,
      request: { event: 'list-my-tags', payload: {} },
      match: (f) => f.event === 'tags-list',
    });

    const admin = await connect(page, 'admin', room);
    await send(page, admin, {
      event: 'kick-by-tag',
      payload: { group: 'role', key: 'troll', reason: 'spam' },
    });

    await waitForFrame(page, alice, (f) => f.event === '__kicked__');
    await page.waitForTimeout(200);
    const bobFrames = await frames(page, bob);
    const bobKicked = bobFrames.find((f) => f.event === '__kicked__');
    expect(bobKicked).toBeUndefined();
  });

  test('count by tag ref returns the number of connections holding that ref', async ({
    page,
  }, testInfo) => {
    const room = `tt-count-${testInfo.testId}`;
    const alice = await connect(page, 'alice', room);
    const bob = await connect(page, 'bob', room);
    await send(page, alice, {
      event: 'add-tag',
      payload: { kind: 'ephemeral', group: 'role', key: 'admin' },
    });
    await send(page, bob, {
      event: 'add-tag',
      payload: { kind: 'ephemeral', group: 'role', key: 'admin' },
    });

    // Bob's add-tag is on a separate connection with no ordering guarantee
    // against alice's query, so retry the query itself until the count
    // reflects both connections (a single count-by-tag reply is a snapshot,
    // it will not update on its own).
    let two!: WireFrame;
    await expect(async () => {
      two = await queryFresh(page, {
        id: alice,
        request: { event: 'count-by-tag', payload: { group: 'role', key: 'admin' } },
        match: (f) => f.event === 'count-result',
      });
      expect(two.payload.count).toBe(2);
    }).toPass({ timeout: 10_000 });

    // A ref nobody holds counts zero.
    await send(page, alice, { event: 'count-by-tag', payload: { group: 'role', key: 'nobody' } });
    const zero = await waitForFrame(
      page,
      alice,
      (f) => f.event === 'count-result' && f.payload.count === 0,
    );
    expect(zero.payload.count).toBe(0);
  });

  test('group handle reflects has/keys/connections/count over the wire', async ({
    page,
  }, testInfo) => {
    const room = `tt-groupstats-${testInfo.testId}-${Date.now()}`;
    const alice = await connect(page, 'alice', room);
    const bob = await connect(page, 'bob', room);

    await send(page, alice, {
      event: 'add-tag',
      payload: { kind: 'ephemeral', group: 'role', key: 'admin' },
    });
    await send(page, bob, {
      event: 'add-tag',
      payload: { kind: 'ephemeral', group: 'role', key: 'viewer' },
    });
    // alice holds 'admin': has('admin') true; two distinct connections in the
    // group; both active keys listed. Bob's add-tag is on a separate
    // connection with no ordering guarantee against alice's query, so retry
    // the query itself until the group totals reflect both connections.
    let stats!: WireFrame;
    await expect(async () => {
      stats = await queryFresh(page, {
        id: alice,
        request: { event: 'group-stats', payload: { key: 'admin' } },
        match: (f) => f.event === 'group-stats-result',
      });
      expect(stats.payload.count).toBe(2);
      expect(stats.payload.connections).toBe(2);
    }).toPass({ timeout: 10_000 });
    expect(stats.payload.has).toBe(true);

    expect((stats.payload.keys as string[]).sort()).toEqual(['admin', 'viewer']);

    // A key alice does not hold reports has=false but the group totals stay.
    await send(page, alice, { event: 'group-stats', payload: { key: 'viewer' } });
    const stats2 = await waitForFrame(
      page,
      alice,
      (f) => f.event === 'group-stats-result' && f.payload.has === false,
    );
    expect(stats2.payload.has).toBe(false);
    expect(stats2.payload.count).toBe(2);
  });

  test('a schema-backed tag group rejects an out-of-schema value', async ({ page }, testInfo) => {
    const room = `tt-schema-${testInfo.testId}`;
    const c = await connect(page, 'alice', room);

    // A value inside the picklist is accepted.
    await send(page, c, {
      event: 'add-tag',
      payload: { kind: 'ephemeral', group: 'color', key: 'red' },
    });
    await send(page, c, { event: 'list-my-tags', payload: {} });
    const list = await waitForFrame(page, c, (f) => f.event === 'tags-list');
    expect(list.payload.tags).toContainEqual({ kind: 'ephemeral', group: 'color', key: 'red' });

    // A value outside the picklist is rejected on the wire.
    await send(page, c, {
      event: 'add-tag',
      payload: { kind: 'ephemeral', group: 'color', key: 'yellow' },
    });
    const err = await waitForFrame(
      page,
      c,
      (f) => f.event === '__error__' && f.payload.code === 'validation-failed',
    );
    expect(err.payload.code).toBe('validation-failed');
  });

  test('a removed persistent tag is not resurrected on reconnect', async ({ page }, testInfo) => {
    const room = `tt-rm-${testInfo.testId}`;
    const c1 = await connect(page, 'alice', room);
    await send(page, c1, {
      event: 'add-tag',
      payload: { kind: 'persistent', group: 'favorite', key: 'room-99' },
    });
    await send(page, c1, {
      event: 'remove-tag',
      payload: { kind: 'persistent', group: 'favorite', key: 'room-99' },
    });

    await close(page, c1);

    const c2 = await connect(page, 'alice', room);
    // The removal write may not have landed the instant close() runs, so
    // retry the list query instead of trusting a single fixed delay.
    await expect(async () => {
      const list = await queryFresh(page, {
        id: c2,
        request: { event: 'list-my-tags', payload: {} },
        match: (f) => f.event === 'tags-list',
      });
      expect(list.payload.tags).not.toContainEqual({
        kind: 'persistent',
        group: 'favorite',
        key: 'room-99',
      });
    }).toPass({ timeout: 10_000 });
  });
});
