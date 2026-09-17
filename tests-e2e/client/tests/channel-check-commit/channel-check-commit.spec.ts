import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: @wskit/client's channel subscribe (check + commit) against the
// real wskit `channel-check-commit` server definition. Adapter-oblivious — it talks to
// whatever server the run booted over the /ws proxy.
async function open(page: Page, room: string, username = 'alice'): Promise<void> {
  await page.goto(`/tests/channel-check-commit/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

// Open a fresh context on the same room with its own identity, then admit it to
// the room with a valid token — used to fill capacity from other connections.
async function fillRoom(browser: Browser, room: string, username: string): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await open(page, room, username);
  await page.getByTestId('sub-member').click();
  await expect(page.getByTestId('subscribed')).toHaveText('yes');
}

test.describe('channel-check-commit (conformance)', () => {
  test('a valid token is admitted — subscribe() resolves and onSubscribed fires', async ({
    page,
  }, testInfo) => {
    await open(page, `ccc-ok-${testInfo.testId}`);
    await page.getByTestId('sub-member').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await expect(page.getByTestId('subscribe-error')).toHaveText('');
  });

  test('an unknown token is rejected — subscribe() rejects with a typed error', async ({
    page,
  }, testInfo) => {
    await open(page, `ccc-unknown-${testInfo.testId}`);
    await page.getByTestId('sub-unknown').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText('internal-error');
    await expect(page.getByTestId('subscribed')).toHaveText('');
  });

  test('a banned token is rejected by commit — subscribe() rejects with a typed error', async ({
    page,
  }, testInfo) => {
    await open(page, `ccc-banned-${testInfo.testId}`);
    await page.getByTestId('sub-banned').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText('internal-error');
    await expect(page.getByTestId('subscribed')).toHaveText('');
  });

  test('capacity is enforced — subscribe() is rejected once the room is full', async ({
    page,
    browser,
  }, testInfo) => {
    const room = `ccc-cap-${testInfo.testId}`;
    await fillRoom(browser, room, 'bob');
    await fillRoom(browser, room, 'carol');

    await open(page, room);
    await page.getByTestId('sub-member').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText('internal-error');
    await expect(page.getByTestId('subscribed')).toHaveText('');
  });
});
