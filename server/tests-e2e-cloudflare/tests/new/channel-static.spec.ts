import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('channel-static', () => {
  async function openPage(page: Page, room: string, username = 'testuser') {
    await page.goto(`/channel-static?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('_subscribe joins the channel and sends _subscribeOk', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('1');
  });

  test('two _subscribe calls are idempotent and both ack', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('1');
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('2');
  });

  test('subscribing to an unknown channel emits _error with code channel-not-found', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-bogus').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText(
      'does-not-exist:channel-not-found',
    );
  });

  test('_unsubscribe when not subscribed is a silent no-op', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Never subscribed; unsubscribe should be ignored without an error frame.
    await page.getByTestId('unsubscribe-room').click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('subscribe-error')).toHaveText('');
  });

  test('publishing to a channel without subscribing first is silently dropped', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('publish-without-sub').click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('user-messages')).toHaveText('');
  });

  test('onBeforeSubscribe Block rejection prevents the subscription', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`, 'blocked-user');
    await page.getByTestId('subscribe-room').click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('0');
  });

  test('ctx.channel.broadcast reaches every subscribed member', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');
    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    // ctx.channel.broadcast fans out to OTHER members; sender does not
    // receive their own broadcast.
    await a.getByTestId('send-hello').click();
    await expect(b.getByTestId('user-messages')).toContainText('alice:hello');
    await a.waitForTimeout(300);
    await expect(a.getByTestId('user-messages')).toHaveText('');

    await ctxA.close();
    await ctxB.close();
  });

  test('onSubscribe broadcasts a system message to existing members', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await a.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');

    // Bob joining triggers onSubscribe which broadcasts "bob entered" to alice.
    await openPage(b, room, 'bob');
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('system-messages')).toContainText('bob entered');

    await ctxA.close();
    await ctxB.close();
  });

  test('onUnsubscribe broadcasts a system message to remaining members', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');
    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    await b.getByTestId('unsubscribe-room').click();
    await expect(a.getByTestId('system-messages')).toContainText('bob left');

    await ctxA.close();
    await ctxB.close();
  });
});
