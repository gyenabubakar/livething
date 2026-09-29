import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: @livething/client's channels() against the real LiveThing
// `channel-static` server definition. Adapter-oblivious — it talks to whatever server the
// run booted over the /ws proxy.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/channel-static/index.html?room=${room}&username=${username}`);
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

test.describe('channel-static (conformance)', () => {
  test('subscribe() resolves and onSubscribed fires', async ({ page }, testInfo) => {
    await open(page, `ch-sub-${testInfo.testId}`, 'alice');
    await page.getByTestId('sub-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await expect(page.getByTestId('on-subscribed-source')).toHaveText('client');
  });

  test('subscribing to an unknown channel rejects with channel-not-found', async ({
    page,
  }, testInfo) => {
    await open(page, `ch-bogus-${testInfo.testId}`, 'alice');
    await page.getByTestId('sub-bogus').click();
    await expect(page.getByTestId('sub-error')).toHaveText('channel-not-found');
  });

  test('unsubscribe flips the subscribed flag back', async ({ page }, testInfo) => {
    await open(page, `ch-unsub-${testInfo.testId}`, 'alice');
    await page.getByTestId('sub-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('unsub-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('no');
  });

  test('the status store reports subscribing, then subscribed, then unsubscribed', async ({
    page,
  }, testInfo) => {
    await open(page, `ch-status-${testInfo.testId}`, 'alice');
    await page.getByTestId('sub-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await expect(page.getByTestId('status-log')).toHaveText('subscribing,subscribed');
    await page.getByTestId('unsub-room').click();

    await expect(page.getByTestId('status-log')).toHaveText('subscribing,subscribed,unsubscribed');
  });

  test('a channel-scoped stream yields its chunks and ends', async ({ page }, testInfo) => {
    await open(page, `ch-stream-${testInfo.testId}`, 'alice');
    await page.getByTestId('sub-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('start-stream').click();
    await expect(page.getByTestId('stream-chunks')).toHaveText('0,1,2');

    await expect(page.getByTestId('stream-end')).toHaveText('yes');
  });

  test('send() broadcasts to OTHER members, not the sender', async ({ browser }, testInfo) => {
    const room = `ch-broadcast-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await alice.page.getByTestId('sub-room').click();
    await bob.page.getByTestId('sub-room').click();
    await expect(alice.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('subscribed')).toHaveText('yes');

    await alice.page.getByTestId('send-hello').click();
    await expect(bob.page.getByTestId('user-messages')).toContainText('alice:hello');
    await expect(alice.page.getByTestId('user-messages')).not.toContainText('alice:hello');

    await alice.close();
    await bob.close();
  });

  test('manual `continueStream` needs a fresh ephemeral channel subscribe', async ({
    browser,
  }, testInfo) => {
    const room = `ch-manual-reconnect-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await alice.page.getByTestId('sub-room').click();
    await bob.page.getByTestId('sub-room').click();
    await expect(alice.page.getByTestId('subscribed-count')).toHaveText('1');
    await alice.page.getByTestId('disconnect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('closed');

    await alice.page.getByTestId('connect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('subscribed-count')).toHaveText('1');

    await alice.page.getByTestId('sub-room').click();
    await expect(alice.page.getByTestId('subscribed-count')).toHaveText('2');
    await expect(alice.page.getByTestId('on-subscribed-source')).toHaveText('client');
    await alice.page.getByTestId('send-hello').click();
    await expect(bob.page.getByTestId('user-messages')).toContainText('alice:hello');

    await alice.close();
    await bob.close();
  });

  test('background resume restores an ephemeral channel before sends resume', async ({
    browser,
  }, testInfo) => {
    const room = `ch-background-resume-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await alice.page.getByTestId('sub-room').click();
    await bob.page.getByTestId('sub-room').click();
    await expect(alice.page.getByTestId('subscribed-count')).toHaveText('1');
    await alice.page.getByTestId('hide').click();
    await expect(alice.page.getByTestId('status')).toHaveText('closed');

    await alice.page.getByTestId('show').click();
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('subscribed-count')).toHaveText('2');
    await expect(alice.page.getByTestId('on-subscribed-source')).toHaveText('client');

    await alice.page.getByTestId('send-hello').click();
    await expect(bob.page.getByTestId('user-messages')).toContainText('alice:hello');

    await alice.close();
    await bob.close();
  });

  test('members and onMemberJoin update when a peer joins', async ({ browser }, testInfo) => {
    const room = `ch-join-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    await alice.page.getByTestId('sub-room').click();
    await expect(alice.page.getByTestId('subscribed')).toHaveText('yes');

    const bob = await openMember(browser, room, 'bob');
    await bob.page.getByTestId('sub-room').click();

    await expect(alice.page.getByTestId('member-joins')).toContainText('room:');
    await expect(alice.page.getByTestId('members-count')).not.toHaveText('0');

    await alice.close();
    await bob.close();
  });

  test('onMemberLeave fires when a peer unsubscribes', async ({ browser }, testInfo) => {
    const room = `ch-leave-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await alice.page.getByTestId('sub-room').click();
    await bob.page.getByTestId('sub-room').click();
    await expect(alice.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('subscribed')).toHaveText('yes');

    await bob.page.getByTestId('unsub-room').click();
    await expect(alice.page.getByTestId('member-leaves')).toContainText('room:');

    await alice.close();
    await bob.close();
  });
});
