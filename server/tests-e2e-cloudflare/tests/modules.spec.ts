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

  test('module onOutgoing counts outgoing messages', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);

    await page.getByTestId('outgoing-count-btn').click();
    await waitForText(page, 'outgoing-count', /outgoing: [1-9]/);
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
});
