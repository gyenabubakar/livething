import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
}

test.describe('subscribe rejection', () => {
  test('chat rejects blocked-user (no _subscribeOk)', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('username-input').fill('blocked-user');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('chat-join-btn').click();
    await page.waitForTimeout(500);
    const subscribed = await page.getByTestId('chat-subscribed').textContent();
    expect(subscribed).toBe('');
  });

  test('dynamic room rejects banned-user (no _subscribeOk)', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('username-input').fill('banned-user');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('room-join-btn').click();
    await page.waitForTimeout(500);
    const subscribed = await page.getByTestId('room-subscribed').textContent();
    expect(subscribed).toBe('');
  });

  test('chat rejects blocked-user with error payload', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('username-input').fill('blocked-user');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('chat-join-btn').click();
    await waitForText(page, 'subscribe-error', /chat:/);
  });

  test('upgrade rejection: no username closes connection', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      return new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws`);
        ws.onclose = (e) => resolve(`closed:${e.code}`);
        ws.onerror = () => {
          // onerror fires before onclose in some browsers, wait for onclose
        };
        setTimeout(() => resolve('timeout'), 5000);
      });
    });
    expect(result).toBe('closed:4001');
  });
});
