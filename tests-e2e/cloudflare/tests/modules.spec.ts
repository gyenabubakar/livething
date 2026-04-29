import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
}

test.describe('modules handler', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/modules?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('module onConnect fires (drizzle-ready)', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
  });

  test('insert record via module API', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id: \d+/);
  });

  test('get all records via module API', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);
    await page.getByTestId('get-all-btn').click();
    await waitForText(page, 'record-list', /test-item/);
  });

  test('module onOutgoing can transform a module-owned outgoing event', async ({ page }) => {
    await waitForText(page, 'drizzle-ready-payload', /"tables":\["records"\]/);
    await waitForText(page, 'drizzle-ready-payload', /"hooked":true/);
  });

  test('get single record via module API', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);
    await page.getByTestId('get-one-btn').click();
    await waitForText(page, 'single-record', /test-item/);
  });

  test('delete record via module API', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);
    await page.getByTestId('delete-btn').click();
    await waitForText(page, 'delete-result', 'deleted');
  });

  test('get record count via module API', async ({ page }) => {
    await page.getByTestId('count-btn').click();
    await waitForText(page, 'record-count', /count: \d+/);
  });

  test('module onIncoming counts messages', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);

    await page.getByTestId('msg-count-btn').click();
    await waitForText(page, 'message-count', /messages: [3-9]|messages: \d{2,}/);
  });

  test('module scheduled task fires on trigger', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('vacuum-btn').click();
    await waitForText(page, 'vacuum-result', /vacuum:\d+/, 10_000);
  });

  test('module onIncoming can rewrite incoming payload', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('module-rewrite-btn').click();
    await waitForText(page, 'module-rewrite-result', 'text:rewritten:hello,rewritten:true');
  });

  test('module scheduled every: fires repeatedly', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('trigger-module-every-btn').click();
    await expect(async () => {
      const count = Number(await page.getByTestId('module-every-count').textContent());
      expect(count).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 15_000 });
  });

  test('module scheduled retry: flaky task succeeds after retries', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('trigger-module-flaky-btn').click();
    await waitForText(page, 'module-flaky-result', /attempts:[3-9]/, 10_000);
  });

  test('module scheduled DLQ: always-fail task lands in DLQ', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('trigger-module-always-fail-btn').click();
    await expect(async () => {
      await page.getByTestId('trigger-module-query-dlq-btn').click();
      const result = await page.getByTestId('module-dlq-result').textContent();
      expect(result).toMatch(/drizzle-module-always-fail:attempts=/);
    }).toPass({ timeout: 15_000 });
    const result = await page.getByTestId('module-dlq-result').textContent();
    expect(result).toContain('module permanent failure');
  });

  test('module onOutgoing counts outgoing messages', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);

    await page.getByTestId('outgoing-count-btn').click();
    await waitForText(page, 'outgoing-count', /outgoing: [1-9]/);
  });

  test('module hooks can observe generateId and getState', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');

    await page.getByTestId('generated-id-btn').click();
    await waitForText(page, 'generated-id-result', /generated: drizzle[-_]/);

    await page.getByTestId('last-state-btn').click();
    await waitForText(page, 'last-state-result', /"username":"testuser"/);
    await waitForText(page, 'last-state-result', /"tags":\[\]/);
  });

  test('module onDisconnect increments counter', async ({ browser }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/modules?room=${room}`);
    await page2.goto(`/modules?room=${room}`);

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

  test('module typed error reaches the client with code and detail intact', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}-err`;

    const err = await page.evaluate(async (currentRoom) => {
      type Msg = { event: string; payload: Record<string, unknown> };
      return new Promise<Msg>((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${location.host}/ws/modules?username=${encodeURIComponent('erruser')}&room=${encodeURIComponent(currentRoom)}`;
        const ws = new WebSocket(url);
        ws.onopen = () => {
          ws.send(JSON.stringify({ event: 'trigger-module-denied', payload: {} }));
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return;
          const parsed = JSON.parse(ev.data) as Msg;
          if (parsed.event === '_error' && (parsed.payload as { code?: string }).code) {
            resolve(parsed);
            ws.close();
          }
        };
        ws.onerror = () => reject(new Error('ws failed'));
        setTimeout(() => reject(new Error('timeout')), 5_000);
      });
    }, room);

    const payload = err.payload as { code: string; detail?: { reason?: string; op?: string } };
    expect(payload.code).toBe('e2e-drizzle/denied');
    expect(payload.detail?.reason).toBe('test denial');
    expect(payload.detail?.op).toBe('insert');
  });

  test('module onShutdown is observable after shutdown and reconnect', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;

    await page.getByTestId('shutdown-count-btn').click();
    await waitForText(page, 'shutdown-count', 'shutdowns: 0');

    const response = await page.request.post(`/ws/modules/shutdown?room=${room}`);
    expect(response.status()).toBe(204);

    await waitForText(page, 'status', 'disconnected', 15_000);
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await waitForText(page, 'db-connected', 'db-ready');

    await page.getByTestId('shutdown-count-btn').click();
    await waitForText(page, 'shutdown-count', 'shutdowns: 1');
  });

  test('module hooks.getState() inside a stream generator returns the stream owner connection id', async ({
    page,
  }, testInfo) => {
    // Pre-fix the engine bracketed setActiveConnectionId around generator
    // construction (which only returns the iterator — the body never runs
    // there). By the time iterator.next() advanced the body, the active id
    // was cleared. Module APIs that called hooks.getState() inside a
    // stream generator saw `undefined`.
    const room = `test-${testInfo.testId}-stream-state`;
    await page.goto(`/modules?room=${room}`);
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
