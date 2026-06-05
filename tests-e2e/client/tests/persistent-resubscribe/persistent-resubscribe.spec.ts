import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: a WARM reconnect of a persistent, check-gated channel must not
// double the subscribe flow. The client does not re-subscribe a persistent
// channel — the server auto-rejoins it from the durable membership — and the
// server does not fire onSubscribe on that rejoin. So after one warm reconnect
// onSubscribed has fired twice (the first client subscribe + one server rejoin)
// while the onSubscribe hook ran exactly once.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/persistent-resubscribe/index.html?room=${room}&username=${username}`);
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

test.describe('persistent-resubscribe (conformance)', () => {
  test('a warm reconnect does not re-run the subscribe flow', async ({ page }, testInfo) => {
    await open(page, `persist-resub-${testInfo.testId}`, 'alice');

    await page.getByTestId('sub').click();
    await expect(page.getByTestId('on-subscribed')).toHaveText('1');
    await expect(page.getByTestId('flow-ran')).toHaveText('1');

    await page.getByTestId('drop').click();
    await expect(page.getByTestId('status')).toHaveText('reconnecting');
    await expect(page.getByTestId('status')).toHaveText('open');
    await expect(page.getByTestId('reconnects')).toHaveText('1');

    // The server auto-rejoin pushes an unsolicited __subscribeOk__ (source
    // 'server'), so onSubscribed fires a second time.
    await expect(page.getByTestId('on-subscribed')).toHaveText('2');

    // The onSubscribe hook did NOT fire on the rejoin, and the client did NOT
    // re-subscribe — either would have pushed flow-ran past 1.
    await page.waitForTimeout(300);
    await expect(page.getByTestId('flow-ran')).toHaveText('1');
  });

  test('a warm reconnect keeps presence and a witness broadcast still reaches the rejoined socket', async ({
    browser,
  }, testInfo) => {
    const room = `persist-resub-witness-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await alice.page.getByTestId('sub').click();
    await bob.page.getByTestId('sub').click();
    await expect(alice.page.getByTestId('on-subscribed')).toHaveText('1');
    await expect(bob.page.getByTestId('on-subscribed')).toHaveText('1');

    // Alice sees Bob in the room.
    await expect.poll(() => alice.page.getByTestId('members-count').textContent()).not.toBe('0');

    // Alice warm-reconnects (the server drops her, the client reconnects).
    await alice.page.getByTestId('drop').click();
    await expect(alice.page.getByTestId('status')).toHaveText('reconnecting');
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('on-subscribed')).toHaveText('2');

    // Members repopulate from the rejoin's fresh __memberSync__.
    await expect.poll(() => alice.page.getByTestId('members-count').textContent()).not.toBe('0');

    // Bob broadcasts WITHOUT Alice re-subscribing — it still reaches her
    // auto-rejoined socket.
    await bob.page.getByTestId('send').click();
    await expect(alice.page.getByTestId('room-messages')).toContainText('bob:witness ping');

    await alice.close();
    await bob.close();
  });
});
