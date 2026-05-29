import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

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

    await page1.getByTestId('disconnect-count-btn').click();
    await waitForText(page1, 'disconnect-count', /disconnects: [1-9]/);

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
          ws.send(JSON.stringify({ event: 'trigger-plugin-denied', payload: {} }));
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return;
          const parsed = JSON.parse(ev.data) as Msg;
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
    expect(payload.code).toBe('__e2e:drizzle:denied');
    expect(payload.detail?.reason).toBe('test denial');
    expect(payload.detail?.op).toBe('insert');
  });

  test('plugin onShutdown is observable after shutdown and reconnect', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;

    await page.getByTestId('shutdown-count-btn').click();
    await waitForText(page, 'shutdown-count', 'shutdowns: 0');

    const response = await page.request.post(`/ws/plugins/shutdown?room=${room}`);
    expect(response.status()).toBe(204);

    await waitForText(page, 'status', { text: 'disconnected', timeout: 15_000 });
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await waitForText(page, 'db-connected', 'db-ready');

    await page.getByTestId('shutdown-count-btn').click();
    await waitForText(page, 'shutdown-count', 'shutdowns: 1');
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
        JSON.stringify({ event: '__streamCancel__', payload: {}, __wskit: { streamId: id } }),
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
    // Pre-fix the engine awaited generator.return() inside
    // cancelActiveStreamsForConnection without catching. A stream whose
    // `finally` block threw (e.g. external resource cleanup failing)
    // aborted the rest of handleConnectionClose — onDisconnect hooks
    // never ran, channel members were never notified, the connection
    // entry leaked. The fix catches and logs per-stream and continues
    // the cleanup.
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

    // Observer asks for the disconnect count from the drizzle plugin's
    // onDisconnect hook. If the stream cleanup failure aborted the close,
    // the count would stay 0. Post-fix it ticks to 1.
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
    // Pre-fix the engine bracketed setActiveConnectionId around generator
    // construction (which only returns the iterator — the body never runs
    // there). By the time iterator.next() advanced the body, the active id
    // was cleared. Plugin APIs that called hooks.getState() inside a
    // stream generator saw `undefined`.
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
