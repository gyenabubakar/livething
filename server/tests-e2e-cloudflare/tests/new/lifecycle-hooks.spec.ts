import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('lifecycle-hooks', () => {
  async function openPage(page: Page, room: string, username = 'testuser') {
    await page.goto(`/lifecycle-hooks?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('onConnect fires and sends an event the connecting client can observe', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`, 'alice');
    await expect(page.getByTestId('connected-user')).toHaveText('alice');
  });

  test('onDisconnect broadcasts to remaining peers when a client leaves', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');

    // Close bob's context entirely — equivalent to the client going away.
    // Alice's DO observes the ws close and fires onDisconnect.
    await ctxB.close();

    // Alice (peer) should observe bob leaving.
    await expect(a.getByTestId('disconnected-users')).toContainText('bob');

    await ctxA.close();
  });

  test('onShutdown broadcasts to all clients before closing the DO', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await openPage(page, room, 'alice');

    const shutdownResponse = await page.request.post(`/ws/lifecycle-hooks/shutdown?room=${room}`);
    expect(shutdownResponse.status()).toBe(204);

    await expect(page.getByTestId('disconnected-users')).toContainText('server-shutdown');
    await expect(page.getByTestId('status')).toHaveText('disconnected');
  });

  test('onUpgrade rejection (missing username) closes the socket with code 4001', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/lifecycle-hooks?room=${room}`);

    const result = await page.evaluate(async (currentRoom) => {
      return new Promise<string>((resolve) => {
        const ws = new WebSocket(
          `ws://${location.host}/ws/lifecycle-hooks?room=${encodeURIComponent(currentRoom)}`,
        );
        ws.onclose = (event) => resolve(`closed:${event.code}`);
        ws.onerror = () => {};
        setTimeout(() => resolve('timeout'), 5_000);
      });
    }, room);

    expect(result).toBe('closed:4001');
  });

  test('HTTP upgrade rejection returns a 403 response (non-WS branch)', async ({
    request,
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/lifecycle-hooks?room=${room}`);
    const origin = new URL(page.url()).origin;

    // Rejected upgrades where code < 1000 fall through the HTTP branch and
    // return a plain HTTP status. Use the existing /ws/reject-http mount
    // (the lifecycle-hooks feature covers the WS-close branch above).
    const response = await request.fetch(`${origin}/ws/reject-http?room=${room}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    expect(response.status()).toBe(403);
  });

  test('onValidationError fires when an incoming payload fails its schema', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-bad').click();
    await expect(page.getByTestId('validation-error')).toHaveText('bad-event');
  });
});
