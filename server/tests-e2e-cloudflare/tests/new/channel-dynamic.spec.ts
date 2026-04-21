import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('channel-dynamic', () => {
  async function openPage(page: Page, room: string, username = 'testuser') {
    await page.goto(`/channel-dynamic?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('subscribing to a name that matches the regex joins the connection', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('room:general');
  });

  test('subscribing without a recognised scope emits _error channel-not-found', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-zzz-no-scope').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText('zzz:channel-not-found');
  });

  test('dynamic channels with different suffixes stay isolated', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    // Bob subscribes to BOTH channels so he's the positive-signal receiver
    // for either side. Alice is only on general.
    await a.getByTestId('sub-general').click();
    await b.getByTestId('sub-general').click();
    await b.getByTestId('sub-vip').click();
    await expect(a.getByTestId('subscribe-ok')).toContainText('room:general');
    await expect(b.getByTestId('subscribe-ok')).toContainText('room:general');
    await expect(b.getByTestId('subscribe-ok')).toContainText('room:vip');

    // Alice publishes to general. Bob (on both) MUST see it on general —
    // that receipt is the positive signal. Bob's vip bucket MUST stay
    // empty, proving dynamic-scope isolation.
    await a.getByTestId('send-general').click();
    await expect(b.getByTestId('user-msgs-general')).toContainText('alice:hello-general');
    await expect(b.getByTestId('user-msgs-vip')).toHaveText('');

    await ctxA.close();
    await ctxB.close();
  });

  test('ctx.channel.broadcast fans out within the dynamic name to peers', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    await a.getByTestId('sub-general').click();
    await b.getByTestId('sub-general').click();
    await expect(a.getByTestId('subscribe-ok')).toContainText('room:general');
    await expect(b.getByTestId('subscribe-ok')).toContainText('room:general');

    await a.getByTestId('send-general').click();
    await expect(b.getByTestId('user-msgs-general')).toContainText('alice:hello-general');

    await ctxA.close();
    await ctxB.close();
  });

  test('onSubscribe broadcasts a system message to existing dynamic members', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await a.getByTestId('sub-general').click();
    await expect(a.getByTestId('subscribe-ok')).toContainText('room:general');

    await openPage(b, room, 'bob');
    await b.getByTestId('sub-general').click();
    await expect(a.getByTestId('system-msgs-general')).toContainText('bob entered');

    await ctxA.close();
    await ctxB.close();
  });
});
