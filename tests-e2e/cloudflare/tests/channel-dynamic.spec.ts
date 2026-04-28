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

  test('subscribing with a name that fails the family regex emits _error channel-not-found', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // _channelScope='room' is a valid family; _channel='admin' does NOT match /^room:.+$/.
    // The server must reject this rather than silently accept it as a 'room' subscription.
    await page.getByTestId('sub-name-fails-regex').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText('admin:channel-not-found');
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

  test('ctx.channel.broadcast reaches peers subscribed to the same dynamic channel name', async ({
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

  test('onUnsubscribe broadcasts a system message when client leaves the dynamic channel', async ({
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

    await b.close();
    await expect(a.getByTestId('system-msgs-general')).toContainText('bob left');

    await ctxA.close();
    await ctxB.close();
  });

  test('onBeforeSubscribe sync rejection prevents subscription for banned-user', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`, 'banned-user');
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-error')).toContainText('room:general');
    await expect(page.getByTestId('subscribe-ok')).toHaveText('');
  });

  test('onBeforeSubscribe async rejection prevents subscription for async-banned-user', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`, 'async-banned-user');
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-error')).toContainText('room:general');
    await expect(page.getByTestId('subscribe-ok')).toHaveText('');
  });

  test('regex scope exposes the full matched name and its suffix inside the handler', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-alpha-123').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('room:alpha-123');
    await page.getByTestId('echo-name-alpha-123').click();
    await expect(page.getByTestId('name-result')).toHaveText('room:alpha-123|alpha-123');
  });

  test('unknown _channelScope round-trips in the _error payload', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-unknown-scope').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText('room:x:channel-not-found');
    await expect(page.getByTestId('subscribe-error-scope')).toHaveText('unknown-family');
  });

  test('two clients on the same dynamic channel name are in the same broadcast group', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');

    // Both subscribe to the SAME dynamic channel (room:general)
    await a.getByTestId('sub-general').click();
    await b.getByTestId('sub-general').click();
    await expect(a.getByTestId('subscribe-ok')).toContainText('room:general');
    await expect(b.getByTestId('subscribe-ok')).toContainText('room:general');

    // ctx.channel.broadcast is peer-only; round-trip to verify the shared group.
    await a.getByTestId('send-general').click();
    await expect(b.getByTestId('user-msgs-general')).toContainText('alice:hello-general');

    await b.getByTestId('send-general').click();
    await expect(a.getByTestId('user-msgs-general')).toContainText('bob:hello-general');

    await ctxA.close();
    await ctxB.close();
  });
});
