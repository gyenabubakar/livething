import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: on a persistent channel a member is keyed by its user id, so a
// peer that reconnects, or opens a second tab, stays one roster entry with one
// stable id in every presence callback.
async function openMember(
  browser: Browser,
  room: string,
  username: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/tests/presence-identity/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();

  await expect(page.getByTestId('status')).toHaveText('open');

  return { page, close: () => ctx.close() };
}

async function subscribe(page: Page): Promise<void> {
  await page.getByTestId('sub').click();
  await expect(page.getByTestId('on-subscribed')).toHaveText('1');
}

test.describe('presence-identity (conformance)', () => {
  test('a peer keeps one roster entry and one member id across a reconnect and a second tab', async ({
    browser,
  }, testInfo) => {
    const room = `presence-identity-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await subscribe(alice.page);
    await subscribe(bob.page);
    await expect(bob.page.getByTestId('members')).toHaveText('alice');
    await expect(bob.page.getByTestId('log')).toHaveText('join:alice,online:alice');

    await alice.page.getByTestId('drop').click();
    await expect(alice.page.getByTestId('status')).toHaveText('reconnecting');
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('on-subscribed')).toHaveText('2');

    await expect(bob.page.getByTestId('log')).toHaveText(
      'join:alice,online:alice,offline:alice,online:alice',
    );
    await expect(bob.page.getByTestId('members')).toHaveText('alice');

    const aliceTab = await openMember(browser, room, 'alice');
    await subscribe(aliceTab.page);
    await expect(aliceTab.page.getByTestId('members')).toHaveText('bob');

    await aliceTab.page.getByTestId('unsub').click();
    await expect(aliceTab.page.getByTestId('members')).toHaveText('');
    await bob.page.waitForTimeout(300);
    await expect(bob.page.getByTestId('log')).toHaveText(
      'join:alice,online:alice,offline:alice,online:alice',
    );
    await expect(bob.page.getByTestId('members')).toHaveText('alice');

    await alice.page.getByTestId('unsub').click();
    await expect(bob.page.getByTestId('log')).toHaveText(
      'join:alice,online:alice,offline:alice,online:alice,leave:alice,offline:alice',
    );
    await expect(bob.page.getByTestId('members')).toHaveText('');

    await aliceTab.close();
    await alice.close();
    await bob.close();
  });

  test('an observer that reconnects keeps a member that is offline, with no leave', async ({
    browser,
  }, testInfo) => {
    const room = `presence-identity-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await subscribe(alice.page);
    await subscribe(bob.page);
    await expect(bob.page.getByTestId('online')).toHaveText('alice');

    await alice.close();
    await expect(bob.page.getByTestId('log')).toHaveText('join:alice,online:alice,offline:alice');
    await expect(bob.page.getByTestId('members')).toHaveText('alice');
    await expect(bob.page.getByTestId('online')).toHaveText('');

    await bob.page.getByTestId('drop').click();
    await expect(bob.page.getByTestId('status')).toHaveText('reconnecting');
    await expect(bob.page.getByTestId('status')).toHaveText('open');
    await expect(bob.page.getByTestId('on-subscribed')).toHaveText('2');

    await expect(bob.page.getByTestId('members')).toHaveText('alice');
    await bob.page.waitForTimeout(300);
    await expect(bob.page.getByTestId('log')).toHaveText('join:alice,online:alice,offline:alice');
    await expect(bob.page.getByTestId('online')).toHaveText('');

    const aliceAgain = await openMember(browser, room, 'alice');
    await expect(aliceAgain.page.getByTestId('on-subscribed')).toHaveText('1');
    await expect(bob.page.getByTestId('log')).toHaveText(
      'join:alice,online:alice,offline:alice,online:alice',
    );
    await expect(bob.page.getByTestId('online')).toHaveText('alice');

    await aliceAgain.close();
    await bob.close();
  });

  test('a kick sends leave, and the kicked user is not rejoined on reconnect', async ({
    browser,
  }, testInfo) => {
    const room = `presence-identity-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await subscribe(alice.page);
    await subscribe(bob.page);
    await expect(bob.page.getByTestId('log')).toHaveText('join:alice,online:alice');

    await bob.page.getByTestId('kick-alice').click();
    await expect(bob.page.getByTestId('log')).toHaveText(
      'join:alice,online:alice,leave:alice,offline:alice',
    );
    await expect(bob.page.getByTestId('members')).toHaveText('');

    await alice.close();
    const aliceAgain = await openMember(browser, room, 'alice');
    await aliceAgain.page.waitForTimeout(300);
    await expect(aliceAgain.page.getByTestId('on-subscribed')).toHaveText('0');

    await expect(bob.page.getByTestId('log')).toHaveText(
      'join:alice,online:alice,leave:alice,offline:alice',
    );
    await expect(bob.page.getByTestId('members')).toHaveText('');

    await aliceAgain.close();
    await bob.close();
  });
});
