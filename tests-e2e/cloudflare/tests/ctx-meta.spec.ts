import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('ctx-meta', () => {
  async function openPage(page: Page, room: string, username = 'testuser') {
    await page.goto(`/ctx-meta?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('ctx.meta (set by onUpgrade) is readable in an incoming handler', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await openPage(page, room, 'meta-alice');

    await page.getByTestId('who-am-i').click();
    await expect(page.getByTestId('echoed-username')).toHaveText('meta-alice');
  });
  test('meta is consistent across multiple incoming messages on the same connection', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await openPage(page, room, 'persistent-meta');

    // Send first request
    await page.getByTestId('who-am-i').click();
    await expect(page.getByTestId('echoed-username')).toHaveText('persistent-meta');

    // Send a second request and verify meta is still the same
    await page.getByTestId('who-am-i').click();
    await expect(page.getByTestId('echoed-username')).toHaveText('persistent-meta');
  });
  test('broadcast delivery includes sender meta accessible to receiving peer', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'broadcaster');
    await openPage(b, room, 'listener');

    // A broadcasts its identity; B receives and echoes A's meta back in response.
    // This tests that B's handler can access A's meta from the broadcast.
    await a.getByTestId('broadcast-identity').click();
    await expect(b.getByTestId('broadcast-received')).toContainText('broadcaster');

    await ctxA.close();
    await ctxB.close();
  });
  test('two clients with different meta maintain separate identity', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'client-a');
    await openPage(b, room, 'client-b');

    // Both ask "who am I" and verify they get their own identity back
    await a.getByTestId('who-am-i').click();
    await expect(a.getByTestId('echoed-username')).toHaveText('client-a');

    await b.getByTestId('who-am-i').click();
    await expect(b.getByTestId('echoed-username')).toHaveText('client-b');

    // Verify one more time to ensure no cross-contamination
    await a.getByTestId('who-am-i').click();
    await expect(a.getByTestId('echoed-username')).toHaveText('client-a');

    await ctxA.close();
    await ctxB.close();
  });
});
