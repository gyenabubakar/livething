import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: @wskit/client's inbox() against the real inbox handler — a
// persistent, inbox-backed channel that guarantees per-member delivery. A member
// OFFLINE when a broadcast lands still receives it, drained on the next reconnect
// after the auto-rejoin. The `__received__` ack settles the durable rows, so a
// later reconnect does not re-deliver them.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/inbox/index.html?room=${room}&username=${username}`);
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

test.describe('inbox (guaranteed per-member delivery)', () => {
  test('an offline member is drained on reconnect and the ack settles the rows', async ({
    browser,
  }, testInfo) => {
    const room = `inbox-drain-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');
    const carol = await openMember(browser, room, 'carol');

    // All join so their durable memberships exist — inbox fan-out writes one row
    // per durable member on every broadcast. Carol stays online as a witness
    // (a channel broadcast excludes the sender, so Bob cannot witness his own).
    await alice.page.getByTestId('sub').click();
    await bob.page.getByTestId('sub').click();
    await carol.page.getByTestId('sub').click();
    await expect(alice.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(carol.page.getByTestId('subscribed')).toHaveText('yes');

    // Alice goes fully offline (no auto-reconnect) BEFORE Bob broadcasts.
    await alice.page.getByTestId('disconnect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('closed');

    await bob.page.getByTestId('send-m1').click();
    await bob.page.getByTestId('send-m2').click();
    // The online witness confirms both broadcasts actually went out.
    await expect(carol.page.getByTestId('messages')).toHaveText('m1,m2');

    // Alice never saw m1/m2 live.
    await expect(alice.page.getByTestId('message-count')).toHaveText('0');

    // Reconnect: the auto-rejoin restores her membership, then the drain re-delivers
    // both held rows in seq order. Guaranteed delivery — the offline window did not
    // drop them.
    await alice.page.getByTestId('connect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('messages')).toHaveText('m1,m2');

    // A second full reconnect: her `__received__` ack settled (deleted) the rows,
    // so nothing is re-delivered — the count stays at 2, proving no double-delivery.
    await alice.page.getByTestId('disconnect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('closed');
    await alice.page.getByTestId('connect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await alice.page.waitForTimeout(400);
    await expect(alice.page.getByTestId('message-count')).toHaveText('2');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('an online member receives an inbox broadcast exactly once (dedup vs the held copy)', async ({
    browser,
  }, testInfo) => {
    const room = `inbox-online-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await alice.page.getByTestId('sub').click();
    await bob.page.getByTestId('sub').click();
    await expect(alice.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('subscribed')).toHaveText('yes');

    // Alice is online: she gets the live frame (pinned to its durable seq/messageId).
    await bob.page.getByTestId('send-m1').click();
    await expect(alice.page.getByTestId('messages')).toHaveText('m1');

    // A warm reconnect would re-deliver her held row, but dedup suppresses the copy
    // she already acked — the count stays at exactly 1.
    await alice.page.getByTestId('disconnect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('closed');
    await alice.page.getByTestId('connect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await alice.page.waitForTimeout(400);
    await expect(alice.page.getByTestId('message-count')).toHaveText('1');

    await alice.close();
    await bob.close();
  });
});
