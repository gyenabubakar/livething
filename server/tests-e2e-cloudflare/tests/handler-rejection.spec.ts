import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
}

test.describe('subscribe rejection', () => {
  test('chat rejects blocked-user (no _subscribeOk)', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/?room=${room}`);
    await page.getByTestId('username-input').fill('blocked-user');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('chat-join-btn').click();
    await waitForText(page, 'subscribe-error', /.+/);
    const subscribed = await page.getByTestId('chat-subscribed').textContent();
    expect(subscribed).toBe('');
  });

  test('dynamic room rejects banned-user (no _subscribeOk)', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/?room=${room}`);
    await page.getByTestId('username-input').fill('banned-user');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('room-join-btn').click();
    await page.getByTestId('echo-btn').click();
    await waitForText(page, 'echo-result', /hello world/);
    const subscribed = await page.getByTestId('room-subscribed').textContent();
    expect(subscribed).toBe('');
  });

  test('chat rejects blocked-user with error payload', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/?room=${room}`);
    await page.getByTestId('username-input').fill('blocked-user');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('chat-join-btn').click();
    await waitForText(page, 'subscribe-error', /chat:/);
  });

  test('upgrade rejection: no username closes connection', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/?room=${room}`);
    for (const pathname of [
      '/ws',
      '/ws/replay',
      '/ws/replay-custom',
      '/ws/replay-snapshot',
      '/ws/modules',
    ]) {
      const result = await page.evaluate(
        async ({ currentRoom, targetPath }) => {
          return new Promise<string>((resolve) => {
            const ws = new WebSocket(
              `ws://${location.host}${targetPath}?room=${encodeURIComponent(currentRoom)}`,
            );
            ws.onclose = (event) => resolve(`closed:${event.code}`);
            ws.onerror = () => {};
            setTimeout(() => resolve('timeout'), 5000);
          });
        },
        { currentRoom: room, targetPath: pathname },
      );

      expect(result).toBe('closed:4001');
    }
  });
});
