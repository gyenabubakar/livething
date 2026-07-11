import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client driving the real `plugins` handler through a CLIENT
// PLUGIN (the scoped model). Proves the scoped socket round-trips every verb over
// the real wire under the plugin's namespace, and that the plugin owns that
// namespace — a raw top-level listener for a plugin frame never fires.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/plugins-scoped/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('plugins — scoped client plugin (conformance)', () => {
  test('scoped send/on round-trips, and the app never sees the plugin frame', async ({
    page,
  }, testInfo) => {
    await open(page, `sc-hello-${testInfo.testId}`);
    await page.getByTestId('hello').click();
    // The plugin's on('welcome') receives __e2e:feed::welcome.
    await expect.poll(async () => page.getByTestId('welcome').textContent()).toBe('alice');
    // The raw top-level listener for the same wire name never fired.
    await expect(page.getByTestId('raw-welcome')).toHaveText('');
  });

  test('scoped request returns the plugin response', async ({ page }, testInfo) => {
    await open(page, `sc-echo-${testInfo.testId}`);
    await page.getByTestId('echo').click();
    await expect.poll(async () => page.getByTestId('echo-result').textContent()).toBe('hello');
  });

  test('scoped durable stream delivers chunks over the wire', async ({ page }, testInfo) => {
    await open(page, `sc-feed-${testInfo.testId}`);
    await page.getByTestId('stream-feed').click();
    await expect.poll(async () => page.getByTestId('feed-rows').textContent()).toBe('1,2,3,4,5');
  });

  test('scoped plain stream delivers chunks over the wire', async ({ page }, testInfo) => {
    await open(page, `sc-plain-${testInfo.testId}`);
    await page.getByTestId('stream-plain').click();
    await expect.poll(async () => page.getByTestId('plain-rows').textContent()).toBe('1,2,3');
  });

  test('scoped recorded stream delivers chunks over the wire', async ({ page }, testInfo) => {
    await open(page, `sc-rec-${testInfo.testId}`);
    await page.getByTestId('stream-recorded').click();
    await expect.poll(async () => page.getByTestId('recorded-rows').textContent()).toBe('1,2,3');
  });

  test('scoped channel subscribes and delivers its broadcast', async ({ page }, testInfo) => {
    await open(page, `sc-room-${testInfo.testId}`);
    await page.getByTestId('join-room').click();
    await expect.poll(async () => page.getByTestId('joined').textContent()).toBe('joined');
  });
});
