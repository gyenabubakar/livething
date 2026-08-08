import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Drives every member of the admin ctx through the app's own `api`, over the
 * real Worker→DO stub. Each route returns the api method's value as JSON, so a
 * failure names the exact ctx member that broke.
 */

interface Frame {
  event: string;
  payload: { text?: string };
}

interface SocketBag {
  ws: WebSocket;
  frames: Frame[];
  closes: string[];
}

declare global {
  interface Window {
    __openSocket(room: string, username: string): Promise<SocketBag>;
    __settle(ms?: number): Promise<void>;
    __a: SocketBag;
    __b: SocketBag;
    __a1: SocketBag;
    __a2: SocketBag;
  }
}

/** Open a socket, collect its frames, and expose them to the assertions. */
const PAGE_HELPERS = `
  window.__openSocket = async (room, username) => {
    const ws = new WebSocket(
      'ws://' + location.host + '/ws/admin?username=' + username + '&room=' + encodeURIComponent(room),
    );
    const frames = [];
    const closes = [];
    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') frames.push(JSON.parse(e.data));
    });
    ws.addEventListener('close', (e) => closes.push(e.code + ':' + e.reason));
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('open failed'));
    });
    return { ws, frames, closes };
  };
  window.__settle = (ms) => new Promise((r) => setTimeout(r, ms ?? 400));
`;

/** POST an admin route and hand back the `result` it reported. */
async function callRoute(page: Page, path: string): Promise<unknown> {
  return page.evaluate(async (url) => {
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`);
    return ((await res.json()) as { result: unknown }).result;
  }, path);
}

/** Call one of the app's own `api` methods. */
async function callApi(page: Page, op: string, params: Record<string, string>): Promise<unknown> {
  return callRoute(page, `/ws/admin/api/${op}?${new URLSearchParams(params).toString()}`);
}

/** Call one of the adapter's built-in flat ops. */
async function callBuiltIn(
  page: Page,
  op: string,
  params: Record<string, string>,
): Promise<unknown> {
  return callRoute(page, `/ws/admin/builtin/${op}?${new URLSearchParams(params).toString()}`);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.addScriptTag({ content: PAGE_HELPERS });
});

test.describe('api(ctx) members over the stub', () => {
  test('connectionCount and connections.all see the live sockets', async ({ page }, testInfo) => {
    const room = `admin-ctx-conns-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
      window.__b = await window.__openSocket(r, 'bob');
    }, room);

    expect(await callApi(page, 'count-now', { room })).toBe(2);
    expect(await callApi(page, 'who-is-online', { room })).toEqual(
      expect.arrayContaining(['alice', 'bob']),
    );
  });

  test('users.get(id) reaches every socket a user holds', async ({ page }, testInfo) => {
    const room = `admin-ctx-users-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a1 = await window.__openSocket(r, 'alice');
      window.__a2 = await window.__openSocket(r, 'alice');
      window.__b = await window.__openSocket(r, 'bob');
    }, room);

    // Both of alice's tabs get it; bob's does not.
    expect(await callApi(page, 'notify-user', { room, userId: 'alice', text: 'hi' })).toBe(2);

    await page.evaluate(() => window.__settle());
    const counts = await page.evaluate(() => ({
      a1: window.__a1.frames.filter((f) => f.event === 'notified').length,
      a2: window.__a2.frames.filter((f) => f.event === 'notified').length,
      bob: window.__b.frames.filter((f) => f.event === 'notified').length,
    }));
    expect(counts).toEqual({ a1: 1, a2: 1, bob: 0 });
  });

  test('connections.get(ref).send reaches exactly one socket', async ({ page }, testInfo) => {
    const room = `admin-ctx-one-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a1 = await window.__openSocket(r, 'alice');
      window.__a2 = await window.__openSocket(r, 'alice');
    }, room);

    const ids = (await callApi(page, 'connection-ids-of', { room, userId: 'alice' })) as string[];
    expect(ids).toHaveLength(2);

    expect(
      await callApi(page, 'poke-connection', { room, connectionId: ids[0]!, text: 'yo' }),
    ).toBe(true);

    await page.evaluate(() => window.__settle());
    const poked = await page.evaluate(() => [
      window.__a1.frames.filter((f) => f.event === 'poked').length,
      window.__a2.frames.filter((f) => f.event === 'poked').length,
    ]);
    // Exactly one of the two tabs got it.
    expect(poked.filter((n) => n === 1)).toHaveLength(1);
    expect(poked.reduce((a, b) => a + b, 0)).toBe(1);
  });

  test('poking an id no live connection holds reports false', async ({ page }, testInfo) => {
    const room = `admin-ctx-missing-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
    }, room);

    expect(await callApi(page, 'poke-connection', { room, connectionId: 'nope', text: 'x' })).toBe(
      false,
    );
  });

  test('users.get(id).close drops every socket that user holds', async ({ page }, testInfo) => {
    const room = `admin-ctx-boot-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a1 = await window.__openSocket(r, 'alice');
      window.__a2 = await window.__openSocket(r, 'alice');
      window.__b = await window.__openSocket(r, 'bob');
    }, room);

    await callApi(page, 'boot-user', { room, userId: 'alice' });
    await page.evaluate(() => window.__settle(600));

    const state = await page.evaluate(() => ({
      a1: window.__a1.closes[0] ?? null,
      a2: window.__a2.closes[0] ?? null,
      bob: window.__b.closes[0] ?? null,
    }));
    expect(state.a1).toBe('4321:booted by admin');
    expect(state.a2).toBe('4321:booted by admin');
    expect(state.bob).toBeNull();
  });

  test('channels.get(name) broadcasts to members and lists them', async ({ page }, testInfo) => {
    const room = `admin-ctx-channel-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
      window.__b = await window.__openSocket(r, 'bob');
      window.__a.ws.send(
        JSON.stringify({ event: '__subscribe__', payload: {}, __wskit: { channel: 'lobby' } }),
      );
      await window.__settle();
    }, room);

    expect(await callApi(page, 'members-of', { room, channel: 'lobby' })).toEqual(['alice']);

    await callApi(page, 'announce-in', { room, channel: 'lobby', text: 'room only' });
    await page.evaluate(() => window.__settle());

    const seen = await page.evaluate(() => ({
      alice: window.__a.frames.filter((f) => f.event === 'room-notice').length,
      bob: window.__b.frames.filter((f) => f.event === 'room-notice').length,
    }));
    expect(seen).toEqual({ alice: 1, bob: 0 });
  });

  test('channels.get(name).kick removes a member', async ({ page }, testInfo) => {
    const room = `admin-ctx-kick-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
      window.__a.ws.send(
        JSON.stringify({ event: '__subscribe__', payload: {}, __wskit: { channel: 'lobby' } }),
      );
      await window.__settle();
    }, room);

    expect(await callApi(page, 'members-of', { room, channel: 'lobby' })).toEqual(['alice']);

    await callApi(page, 'kick-from', { room, channel: 'lobby', userId: 'alice' });
    await page.evaluate(() => window.__settle(600));

    expect(await callApi(page, 'members-of', { room, channel: 'lobby' })).toEqual([]);
  });

  test('schedule queues a task that fires, and cancelScheduled stops it', async ({
    page,
  }, testInfo) => {
    const room = `admin-ctx-schedule-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
    }, room);

    await callApi(page, 'schedule-announce', { room, delayMs: '100', text: 'from-task' });
    await page.evaluate(() => window.__settle(1200));

    const fired = await page.evaluate(() =>
      window.__a.frames.filter((f) => f.event === 'announced').map((f) => f.payload.text),
    );
    expect(fired).toContain('from-task');

    // A cancelled run never arrives.
    await callApi(page, 'schedule-announce', { room, delayMs: '800', text: 'cancelled-task' });
    await callApi(page, 'cancel-announce', { room });
    await page.evaluate(() => window.__settle(1500));

    const after = await page.evaluate(() =>
      window.__a.frames.filter((f) => f.event === 'announced').map((f) => f.payload.text),
    );
    expect(after).not.toContain('cancelled-task');
  });

  test('sql round-trips a row, and waitUntil work lands too', async ({ page }, testInfo) => {
    const room = `admin-ctx-sql-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
    }, room);

    await callApi(page, 'write-note', { room, text: 'note-one' });
    expect(await callApi(page, 'read-notes', { room })).toEqual(['note-one']);

    await callApi(page, 'defer-note', { room, text: 'deferred' });
    await page.evaluate(() => window.__settle(600));
    expect(await callApi(page, 'read-notes', { room })).toEqual(
      expect.arrayContaining(['note-one', 'deferred']),
    );
  });

  test('kv round-trips a value', async ({ page }, testInfo) => {
    const room = `admin-ctx-kv-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
    }, room);

    expect(await callApi(page, 'get-flag', { room, key: 'mode' })).toBeNull();
    await callApi(page, 'put-flag', { room, key: 'mode', text: 'maintenance' });
    expect(await callApi(page, 'get-flag', { room, key: 'mode' })).toBe('maintenance');
  });

  test('env, log, and platform are usable from an api method', async ({ page }, testInfo) => {
    const room = `admin-ctx-plumbing-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
    }, room);

    expect(await callApi(page, 'env-keys', { room })).toEqual(
      expect.arrayContaining(['ADMIN_SERVER']),
    );
    expect(await callApi(page, 'has-platform', { room })).toBe(true);
    // Nothing to assert on the log itself; it must simply not throw over RPC.
    await callApi(page, 'log-something', { room, text: 'hello' });
  });
});

test.describe('built-in flat ops on the stub', () => {
  test('connectionCount() and listConnections() report the live sockets as plain data', async ({
    page,
  }, testInfo) => {
    const room = `admin-builtin-list-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
      window.__b = await window.__openSocket(r, 'bob');
    }, room);

    expect(await callBuiltIn(page, 'connection-count', { room })).toBe(2);

    const listed = (await callBuiltIn(page, 'list-connections', { room })) as {
      id: string;
      userId: string;
      hasRef: boolean;
    }[];
    expect(listed.map((c) => c.userId).sort()).toEqual(['alice', 'bob']);
    // ref() is a method, so it cannot survive the trip to the Worker.
    expect(listed.every((c) => c.hasRef === false)).toBe(true);
  });

  test('sendToConnection and sendToUser deliver over the stub', async ({ page }, testInfo) => {
    const room = `admin-builtin-send-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
      window.__b = await window.__openSocket(r, 'bob');
    }, room);

    const listed = (await callBuiltIn(page, 'list-connections', { room })) as {
      id: string;
      userId: string;
    }[];
    const aliceId = listed.find((c) => c.userId === 'alice')!.id;

    expect(
      await callBuiltIn(page, 'send-to-connection', { room, connectionId: aliceId, text: 'p' }),
    ).toBe(true);
    expect(await callBuiltIn(page, 'send-to-user', { room, userId: 'bob', text: 'n' })).toBe(1);

    await page.evaluate(() => window.__settle());
    const seen = await page.evaluate(() => ({
      alicePoked: window.__a.frames.filter((f) => f.event === 'poked').length,
      bobNotified: window.__b.frames.filter((f) => f.event === 'notified').length,
      bobPoked: window.__b.frames.filter((f) => f.event === 'poked').length,
    }));
    expect(seen).toEqual({ alicePoked: 1, bobNotified: 1, bobPoked: 0 });
  });

  test('sendToConnection reports false for an unknown id', async ({ page }, testInfo) => {
    const room = `admin-builtin-miss-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
    }, room);

    expect(
      await callBuiltIn(page, 'send-to-connection', { room, connectionId: 'nope', text: 'x' }),
    ).toBe(false);
  });

  test('closeUser drops that user only', async ({ page }, testInfo) => {
    const room = `admin-builtin-close-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
      window.__b = await window.__openSocket(r, 'bob');
    }, room);

    await callBuiltIn(page, 'close-user', { room, userId: 'alice' });
    await page.evaluate(() => window.__settle(600));

    const state = await page.evaluate(() => ({
      alice: window.__a.closes[0] ?? null,
      bob: window.__b.closes[0] ?? null,
    }));
    expect(state.alice).toBe('4321:booted by admin');
    expect(state.bob).toBeNull();
  });

  test('broadcast reaches everyone; channel ops reach members only', async ({ page }, testInfo) => {
    const room = `admin-builtin-channel-${testInfo.testId}`;
    await page.evaluate(async (r) => {
      window.__a = await window.__openSocket(r, 'alice');
      window.__b = await window.__openSocket(r, 'bob');
      window.__a.ws.send(
        JSON.stringify({ event: '__subscribe__', payload: {}, __wskit: { channel: 'lobby' } }),
      );
      await window.__settle();
    }, room);

    await callBuiltIn(page, 'broadcast', { room, text: 'everyone' });
    await callBuiltIn(page, 'channel-broadcast', { room, channel: 'lobby', text: 'members' });
    await page.evaluate(() => window.__settle());

    const seen = await page.evaluate(() => ({
      aliceAnnounced: window.__a.frames.filter((f) => f.event === 'announced').length,
      bobAnnounced: window.__b.frames.filter((f) => f.event === 'announced').length,
      aliceNotice: window.__a.frames.filter((f) => f.event === 'room-notice').length,
      bobNotice: window.__b.frames.filter((f) => f.event === 'room-notice').length,
    }));
    expect(seen).toEqual({
      aliceAnnounced: 1,
      bobAnnounced: 1,
      aliceNotice: 1,
      bobNotice: 0,
    });

    expect(await callBuiltIn(page, 'channel-members', { room, channel: 'lobby' })).toEqual([
      'alice',
    ]);

    await callBuiltIn(page, 'channel-kick', { room, channel: 'lobby', userId: 'alice' });
    await page.evaluate(() => window.__settle(600));
    expect(await callBuiltIn(page, 'channel-members', { room, channel: 'lobby' })).toEqual([]);
  });
});
