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
      const url = `${location.origin.replace(/^http/, 'ws')}/ws/typed-tags?room=${encodeURIComponent(
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
      sockets.get(id)?.send(JSON.stringify(frame));
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

test.describe('typed tags', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await installRig(page);
  });

  test('upgrade helper attaches an ephemeral user ref via requireUsername', async ({
    page,
  }, testInfo) => {
    const room = `tt-upgrade-${testInfo.testId}`;
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
    await page.waitForTimeout(150);
    await close(page, c1);

    await page.waitForTimeout(200);

    const c2 = await connect(page, 'alice', room);
    await send(page, c2, { event: 'list-my-tags', payload: {} });
    const list = await waitForFrame(page, c2, (f) => f.event === 'tags-list');
    expect(list.payload.tags).toContainEqual({
      kind: 'persistent',
      group: 'favorite',
      key: 'room-42',
    });
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

    await page.waitForTimeout(100);

    const carol = await connect(page, 'carol', room);
    await send(page, carol, {
      event: 'fan-out-to-tag',
      payload: { group: 'role', key: 'admin', text: 'hi admins' },
    });

    const aliceEcho = await waitForFrame(page, alice, (f) => f.event === 'fan-out-echo');
    const bobEcho = await waitForFrame(page, bob, (f) => f.event === 'fan-out-echo');
    expect(aliceEcho.payload.text).toBe('hi admins');
    expect(bobEcho.payload.text).toBe('hi admins');

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

    await send(page, alice, { event: '__subscribe__', payload: {}, __wskit: { channel: 'room' } });
    await send(page, bob, { event: '__subscribe__', payload: {}, __wskit: { channel: 'room' } });
    await waitForFrame(page, alice, (f) => f.event === '__subscribeOk__');
    await waitForFrame(page, bob, (f) => f.event === '__subscribeOk__');

    await send(page, alice, {
      event: 'add-tag',
      payload: { kind: 'ephemeral', group: 'role', key: 'troll' },
    });
    await page.waitForTimeout(80);

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

    await page.waitForTimeout(100);

    await send(page, alice, { event: 'count-by-tag', payload: { group: 'role', key: 'admin' } });
    const two = await waitForFrame(
      page,
      alice,
      (f) => f.event === 'count-result' && f.payload.count === 2,
    );
    expect(two.payload.count).toBe(2);

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
    await page.waitForTimeout(120);

    // alice holds 'admin': has('admin') true; two distinct connections in the
    // group; both active keys listed.
    await send(page, alice, { event: 'group-stats', payload: { key: 'admin' } });
    const stats = await waitForFrame(page, alice, (f) => f.event === 'group-stats-result');
    expect(stats.payload.has).toBe(true);
    expect(stats.payload.count).toBe(2);
    expect(stats.payload.connections).toBe(2);

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
    await page.waitForTimeout(120);
    await send(page, c1, {
      event: 'remove-tag',
      payload: { kind: 'persistent', group: 'favorite', key: 'room-99' },
    });

    await page.waitForTimeout(120);
    await close(page, c1);
    await page.waitForTimeout(200);

    const c2 = await connect(page, 'alice', room);
    await send(page, c2, { event: 'list-my-tags', payload: {} });
    const list = await waitForFrame(page, c2, (f) => f.event === 'tags-list');
    expect(list.payload.tags).not.toContainEqual({
      kind: 'persistent',
      group: 'favorite',
      key: 'room-99',
    });
  });
});
