import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: a broad smoke across @wskit/client primitives against the real
// wskit `group-full-surface` handler. Adapter-oblivious — it talks to whatever
// server the run booted over the /ws proxy.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/group-full-surface/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

async function openMember(
  browser: Browser,
  room: string,
  username: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await open(page, room, username);
  return { page, close: () => ctx.close() };
}

test.describe('group-full-surface (conformance)', () => {
  test('on() receives the welcome incoming the server sends on connect', async ({
    page,
  }, testInfo) => {
    await open(page, `gfs-welcome-${testInfo.testId}`, 'alice');
    await expect(page.getByTestId('welcome')).toHaveText('alice');
  });

  test('request() resolves with the typed response', async ({ page }, testInfo) => {
    await open(page, `gfs-lookup-${testInfo.testId}`, 'alice');
    await page.getByTestId('lookup').click();
    await expect(page.getByTestId('lookup-hit')).toHaveText('abc');
  });

  test('stream() yields its chunks and ends', async ({ page }, testInfo) => {
    await open(page, `gfs-feed-${testInfo.testId}`, 'alice');
    await page.getByTestId('feed').click();
    await expect(page.getByTestId('feed-chunks')).toHaveText('1,2,3');
    await expect(page.getByTestId('feed-end')).toHaveText('yes');
  });

  test('channel send-msg broadcasts back as room-msg to subscribers', async ({
    browser,
  }, testInfo) => {
    const room = `gfs-ch-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await alice.page.getByTestId('sub-rooms').click();
    await bob.page.getByTestId('sub-rooms').click();
    await expect(alice.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('subscribed')).toHaveText('yes');

    await alice.page.getByTestId('send-msg').click();
    await expect(bob.page.getByTestId('room-msg')).toHaveText('alice:hello room');
    await expect(alice.page.getByTestId('room-msg')).toHaveText('alice:hello room');

    await alice.close();
    await bob.close();
  });
});
