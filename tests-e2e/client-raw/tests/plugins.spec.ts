import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

interface WaitForTextOptions {
  text: string | RegExp;
  timeout?: number;
}

function waitForText(page: Page, testId: string, opts: string | RegExp | WaitForTextOptions) {
  const text = typeof opts === 'string' || opts instanceof RegExp ? opts : opts.text;
  const timeout =
    typeof opts === 'string' || opts instanceof RegExp ? 10_000 : (opts.timeout ?? 10_000);
  return expect(page.getByTestId(testId)).toHaveText(text, { timeout });
}

test.describe('plugins handler', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/plugins?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('plugin onConnect fires (drizzle-ready)', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
  });

  test('insert record via plugin API', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id: \d+/);
  });

  test('get all records via plugin API', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);
    await page.getByTestId('get-all-btn').click();
    await waitForText(page, 'record-list', /test-item/);
  });

  test('plugin onOutgoing can transform a plugin-owned outgoing event', async ({ page }) => {
    await waitForText(page, 'drizzle-ready-payload', /"tables":\["records"\]/);
    await waitForText(page, 'drizzle-ready-payload', /"hooked":true/);
  });

  test('get single record via plugin API', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);
    await page.getByTestId('get-one-btn').click();
    await waitForText(page, 'single-record', /test-item/);
  });

  test('represents a missing single record as JSON null', async ({ page }) => {
    await page.getByTestId('get-one-btn').click();
    await waitForText(page, 'single-record', 'null');
  });

  test('delete record via plugin API', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);
    await page.getByTestId('delete-btn').click();
    await waitForText(page, 'delete-result', 'deleted');
  });

  test('get record count via plugin API', async ({ page }) => {
    await page.getByTestId('count-btn').click();
    await waitForText(page, 'record-count', /count: \d+/);
  });

  test('plugin onIncoming counts messages', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);

    await page.getByTestId('msg-count-btn').click();
    await waitForText(page, 'message-count', /messages: [3-9]|messages: \d{2,}/);
  });

  test('plugin scheduled task fires on trigger', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('vacuum-btn').click();
    await waitForText(page, 'vacuum-result', { text: /vacuum:\d+/, timeout: 10_000 });
  });

  test('plugin onIncoming can rewrite incoming payload', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('plugin-rewrite-btn').click();
    await waitForText(page, 'plugin-rewrite-result', 'text:rewritten:hello,rewritten:true');
  });

  test('plugin scheduled every: fires repeatedly', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('trigger-plugin-every-btn').click();
    await expect(async () => {
      const count = Number(await page.getByTestId('plugin-every-count').textContent());
      expect(count).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 15_000 });
  });

  test('plugin scheduled retry: flaky task succeeds after retries', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('trigger-plugin-flaky-btn').click();
    await waitForText(page, 'plugin-flaky-result', { text: /attempts:[3-9]/, timeout: 10_000 });
  });

  test('plugin scheduled DLQ: always-fail task lands in DLQ', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('trigger-plugin-always-fail-btn').click();
    await expect(async () => {
      await page.getByTestId('trigger-plugin-query-dlq-btn').click();
      const result = await page.getByTestId('plugin-dlq-result').textContent();
      expect(result).toMatch(/drizzle-module-always-fail:attempts=/);
    }).toPass({ timeout: 15_000 });
    const result = await page.getByTestId('plugin-dlq-result').textContent();
    expect(result).toContain('module permanent failure');
  });

  test('plugin onOutgoing counts outgoing messages', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);

    await page.getByTestId('outgoing-count-btn').click();
    await waitForText(page, 'outgoing-count', /outgoing: [1-9]/);
  });

  test('plugin hooks can observe generateId and getState', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');

    await page.getByTestId('generated-id-btn').click();
    await waitForText(page, 'generated-id-result', /generated: drizzle[-_]/);

    await page.getByTestId('last-state-btn').click();
    await waitForText(page, 'last-state-result', /"username":"testuser"/);
    await waitForText(page, 'last-state-result', /"tags":\[\]/);
  });

  test('plugin onDisconnect increments counter', async ({ browser }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/plugins?room=${room}`);
    await page2.goto(`/plugins?room=${room}`);

    await page1.getByTestId('username-input').fill('mod-user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');

    await page2.getByTestId('username-input').fill('mod-user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');

    await page2.getByTestId('disconnect-btn').click();
    await waitForText(page2, 'status', 'disconnected');

    // The page shows "disconnected" before the server has run onDisconnect,
    // so ask again until the count has changed.
    await expect(async () => {
      await page1.getByTestId('disconnect-count-btn').click();
      await expect(page1.getByTestId('disconnect-count')).toHaveText(/disconnects: [1-9]/, {
        timeout: 1_000,
      });
    }).toPass({ timeout: 10_000 });

    await page1.close();
    await page2.close();
  });

  test('plugin typed error reaches the client with code and detail intact', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}-err`;

    const err = await page.evaluate(async (currentRoom) => {
      type Msg = { event: string; payload: Record<string, unknown> };
      return new Promise<Msg>((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${location.host}/ws/plugins?username=${encodeURIComponent('erruser')}&room=${encodeURIComponent(currentRoom)}`;
        const ws = new WebSocket(url);
        ws.onopen = () => {
          ws.send(
            window.__livethingEncode({
              event: '__e2e:drizzle::trigger-plugin-denied',
              payload: {},
            }),
          );
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return;

          const parsed = window.__livethingDecode(ev.data) as Msg;
          if (parsed.event === '__error__' && (parsed.payload as { code?: string }).code) {
            resolve(parsed);
            ws.close();
          }
        };

        ws.onerror = () => reject(new Error('ws failed'));
        setTimeout(() => reject(new Error('timeout')), 5_000);
      });
    }, room);

    const payload = err.payload as { code: string; detail?: { reason?: string; op?: string } };
    expect(payload.code).toBe('__e2e:drizzle::denied');
    expect(payload.detail?.reason).toBe('test denial');
    expect(payload.detail?.op).toBe('insert');
  });

  test('plugin onShutdown is observable after shutdown and reconnect', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;

    // The plugin's shutdown count is persisted in the DO's storage, so it
    // survives reconnects — and survives a Playwright retry that reuses this
    // room. Read the starting value rather than assume 0, then assert one
    // explicit shutdown increments it by exactly 1.
    await page.getByTestId('shutdown-count-btn').click();
    await expect(page.getByTestId('shutdown-count')).toHaveText(/shutdowns: \d+/);
    const before = Number(
      (await page.getByTestId('shutdown-count').textContent())!.replace('shutdowns: ', ''),
    );

    const response = await page.request.post(`/ws/plugins/shutdown?room=${room}`);
    expect(response.status()).toBe(204);

    await waitForText(page, 'status', { text: 'disconnected', timeout: 15_000 });
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await waitForText(page, 'db-connected', 'db-ready');

    await page.getByTestId('shutdown-count-btn').click();
    await waitForText(page, 'shutdown-count', `shutdowns: ${before + 1}`);
  });

  test('__streamCancel__ survives a generator finally throw — websocket stays alive', async ({
    page,
  }, testInfo) => {
    // The connection-close path catches per-stream cleanup throws (commit
    // 168c1b9). The explicit __streamCancel__ path was a separate code
    // path that didn't catch — the throw escaped processTextMessage into
    // the adapter WS callback. The fix mirrors the connection-close catch.
    await page.goto(`/plugins?room=test-${testInfo.testId}-streamcancel`);
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await waitForText(page, 'db-connected', 'db-ready');

    await page.getByTestId('stream-throw-on-cancel-btn').click();
    await expect(async () => {
      const id = (await page.getByTestId('stream-throw-id').textContent()) ?? '';
      expect(id.length).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });
    const streamId = (await page.getByTestId('stream-throw-id').textContent())!;

    // Wait for at least one chunk so the iterator is parked at a yield —
    // .return() will run the user's finally block and throw.
    await expect(async () => {
      const chunks = Number(await page.getByTestId('stream-throw-chunks').textContent());
      expect(chunks).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });

    await page.evaluate((id) => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        window.__livethingEncode({
          event: '__streamCancel__',
          payload: null,
          metadata: { stream: { id: id } },
        }),
      );
    }, streamId);

    // The websocket must still be healthy. A normal request still works.
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id: \d+/);
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('connection close still runs onDisconnect when a stream finally throws on cancel', async ({
    browser,
  }, testInfo) => {
    // A stream's throwing `finally` block is contained and logged so the rest
    // of connection cleanup, including onDisconnect, still runs.
    const room = `multi-${testInfo.testId}-throwfinally`;
    const observer = await browser.newPage();
    const offender = await browser.newPage();
    await observer.goto(`/plugins?room=${room}`);
    await offender.goto(`/plugins?room=${room}`);

    await observer.getByTestId('username-input').fill('observer');
    await observer.getByTestId('connect-btn').click();
    await waitForText(observer, 'status', 'connected');
    await offender.getByTestId('username-input').fill('offender');
    await offender.getByTestId('connect-btn').click();

    await waitForText(offender, 'status', 'connected');

    // Offender starts the stream whose finally throws, waits for at least
    // one chunk so the iterator is parked at a yield (so .return() actually
    // hits the finally), then disconnects.
    await offender.getByTestId('stream-throw-on-cancel-btn').click();
    await expect(async () => {
      const chunks = Number(await offender.getByTestId('stream-throw-chunks').textContent());
      expect(chunks).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });

    await offender.getByTestId('disconnect-btn').click();
    await waitForText(offender, 'status', 'disconnected');

    // Observer asks for the disconnect count from the plugin's onDisconnect hook.
    await expect(async () => {
      await observer.getByTestId('disconnect-count-btn').click();
      await expect(observer.getByTestId('disconnect-count')).toHaveText(/disconnects: [1-9]/, {
        timeout: 1_000,
      });
    }).toPass({ timeout: 15_000 });

    await observer.close();
    await offender.close();
  });

  test('plugin hooks.getState() inside a stream generator returns the stream owner connection id', async ({
    page,
  }, testInfo) => {
    // The active connection ID remains available while each generator step
    // runs, so plugin APIs can read the stream owner's state.
    const room = `test-${testInfo.testId}-stream-state`;
    await page.goto(`/plugins?room=${room}`);
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await waitForText(page, 'db-connected', 'db-ready');

    // Capture the connection id observed at onConnect time — every stream
    // chunk should carry this same id.
    await page.getByTestId('last-state-btn').click();
    await expect(async () => {
      const lastState = await page.getByTestId('last-state-result').textContent();
      expect(lastState).toMatch(/"id":"[^"]+"/);
    }).toPass({ timeout: 5_000 });
    const expectedId = JSON.parse((await page.getByTestId('last-state-result').textContent())!)
      .id as string;

    await page.getByTestId('stream-connection-id-btn').click();
    await expect(async () => {
      const text = (await page.getByTestId('stream-connection-id-chunks').textContent()) ?? '';
      const ids = text.split(',').filter(Boolean);
      expect(ids).toHaveLength(3);
      for (const id of ids) expect(id).toBe(expectedId);
    }).toPass({ timeout: 5_000 });
  });
});

// Raw-wire coverage for `inbox()` on a plugin-owned channel. Every wire string
// here — the channel key, the `chat` event, and the `said` broadcast — carries
// the plugin's `__e2e:feed::` prefix. This proves the namespacing pass and the
// inbox storage agree on that same namespaced channel name: a durable row
// written under one name and read under another would drop delivery silently,
// which no unit test (mocking either side) would catch.
test.describe('plugins handler — inbox() on a plugin channel', () => {
  const CHANNEL = '__e2e:feed::room';

  test('an offline member on a plugin channel is drained on reconnect and its ack stops re-delivery', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}-plugin-inbox`;
    await page.goto('/');
    await installRig(page);

    const alice = await connect(page, { path: '/ws/plugins', username: 'inbox-alice', room });
    const bob = await connect(page, { path: '/ws/plugins', username: 'inbox-bob', room });

    await send(page, alice, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: CHANNEL } },
    });
    await waitForFrame(page, alice, {
      match: (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === CHANNEL,
    });
    await send(page, bob, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: CHANNEL } },
    });
    await waitForFrame(page, bob, {
      match: (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === CHANNEL,
    });

    // Alice goes offline before bob's broadcast.
    await closeSocket(page, alice);

    await send(page, bob, {
      event: '__e2e:feed::chat',
      payload: { text: 'while-offline' },
      metadata: { channel: { name: CHANNEL } },
    });
    await page.waitForTimeout(300);

    // Reconnect under the same username — persistence auto-rejoins the plugin
    // channel and the inbox drain re-delivers the held row.
    const aliceAgain = await connect(page, { path: '/ws/plugins', username: 'inbox-alice', room });
    const drained = await waitForFrame(page, aliceAgain, {
      match: (f) => f.event === '__e2e:feed::said' && f.payload.text === 'while-offline',
    });
    expect(drained.metadata?.channel?.name).toBe(CHANNEL);
    const seq = drained.metadata?.delivery?.seq as number;
    expect(typeof seq).toBe('number');

    // Ack it, settling the durable row.
    await send(page, aliceAgain, {
      event: '__received__',
      payload: { receivedThrough: seq },
      metadata: { channel: { name: CHANNEL } },
    });
    await page.waitForTimeout(300);
    await closeSocket(page, aliceAgain);

    // A further reconnect must NOT re-deliver it.
    const aliceThird = await connect(page, { path: '/ws/plugins', username: 'inbox-alice', room });
    await page.waitForTimeout(600);
    const redelivered = (await frames(page, aliceThird)).filter(
      (f) => f.event === '__e2e:feed::said' && f.payload.text === 'while-offline',
    );
    expect(redelivered).toHaveLength(0);

    await closeSocket(page, bob);
    await closeSocket(page, aliceThird);
  });
});

// Extends the plugin-namespaced inbox proof above to a DYNAMIC channel family.
// `thread` / `thread:{id}` is the plugin's dynamic family: the FAMILY KEY is
// namespaced to `__e2e:feed::thread`, but the concrete channel name stays the
// bare `thread:<id>` — the family key alone is enough to keep two plugins'
// families from colliding, since lookup resolves the family first. The
// fan-out write and the `__received__` read must agree on that same
// (bare name, namespaced family) pair — a mismatch there would silently
// drop delivery.
test.describe('plugins handler — inbox() on a plugin-owned dynamic channel family', () => {
  const FAMILY = '__e2e:feed::thread';
  function threadChannel(id: string) {
    return `thread:${id}`;
  }

  test('an offline member of one thread instance is drained on reconnect, keyed to that instance', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}-plugin-inbox-dynamic`;
    await page.goto('/');
    await installRig(page);

    const alice = await connect(page, {
      path: '/ws/plugins',
      username: 'thread-alice',
      room,
    });
    const bob = await connect(page, { path: '/ws/plugins', username: 'thread-bob', room });

    const channel = threadChannel('t1');
    await send(page, alice, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: channel, family: FAMILY } },
    });
    await waitForFrame(page, alice, {
      match: (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === channel,
    });
    await send(page, bob, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: channel, family: FAMILY } },
    });
    await waitForFrame(page, bob, {
      match: (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === channel,
    });

    await closeSocket(page, alice);

    await send(page, bob, {
      event: '__e2e:feed::post',
      payload: { text: 'while-offline' },
      metadata: { channel: { name: channel, family: FAMILY } },
    });
    await page.waitForTimeout(300);

    const aliceAgain = await connect(page, {
      path: '/ws/plugins',
      username: 'thread-alice',
      room,
    });
    const drained = await waitForFrame(page, aliceAgain, {
      match: (f) => f.event === '__e2e:feed::thread-msg' && f.payload.text === 'while-offline',
    });
    expect(drained.metadata?.channel?.name).toBe(channel);
    expect(drained.metadata?.channel?.family).toBe(FAMILY);
    const seq = drained.metadata?.delivery?.seq as number;

    expect(typeof seq).toBe('number');

    await send(page, aliceAgain, {
      event: '__received__',
      payload: { receivedThrough: seq },
      metadata: { channel: { name: channel, family: FAMILY } },
    });
    await page.waitForTimeout(300);
    await closeSocket(page, aliceAgain);

    const aliceThird = await connect(page, {
      path: '/ws/plugins',
      username: 'thread-alice',
      room,
    });
    await page.waitForTimeout(600);
    const redelivered = (await frames(page, aliceThird)).filter(
      (f) => f.event === '__e2e:feed::thread-msg' && f.payload.text === 'while-offline',
    );
    expect(redelivered).toHaveLength(0);

    await closeSocket(page, bob);
    await closeSocket(page, aliceThird);
  });
});
