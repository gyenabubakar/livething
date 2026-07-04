import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: delivered (inbox) and read (readReceipts) surfaces against the
// real handler. Delivered cursors advance from each member's `__received__` ack;
// seen cursors from markSeen(). Both fan out as `__receipt__` frames into the
// per-channel receipts store. `receivedBy`/`seenBy` round-trip to the server,
// whose authoritative view is surfaced via `cursor-answer` and must agree.
// A dedicated sender (carol) publishes: a channel broadcast excludes the sender,
// so the recipients whose cursors advance are exactly the non-sending members.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/receipts/index.html?room=${room}&username=${username}`);
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

test.describe('receipts (delivered + seen cursors)', () => {
  test('delivered and seen cursors advance, fan out to members, and match the server view', async ({
    browser,
  }, testInfo) => {
    const room = `receipts-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');
    const carol = await openMember(browser, room, 'carol');

    await alice.page.getByTestId('sub').click();
    await bob.page.getByTestId('sub').click();
    await carol.page.getByTestId('sub').click();
    await expect(alice.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(carol.page.getByTestId('subscribed')).toHaveText('yes');

    // Carol broadcasts; the channel excludes the sender, so alice and bob receive
    // it live and auto-ack `__received__` (carol's own held row stays undelivered).
    await carol.page.getByTestId('send').click();
    await expect(alice.page.getByTestId('messages')).toHaveText('hello');
    await expect(bob.page.getByTestId('messages')).toHaveText('hello');

    // Both recipients' delivered cursors advance and fan out — Alice sees BOTH rows.
    await expect(alice.page.getByTestId('receipt-view')).toContainText('alice=r');
    await expect(alice.page.getByTestId('receipt-view')).toContainText('bob=r');

    // The server's authoritative view: exactly the two recipients received seq 1.
    await alice.page.getByTestId('ask-server-received').click();
    await expect(alice.page.getByTestId('server-answer')).toHaveText('received:alice|bob');

    // No one has marked seen yet — the server's seen set is empty.
    await alice.page.getByTestId('ask-server-seen').click();
    await expect(alice.page.getByTestId('server-answer')).toHaveText('seen:');

    // Alice marks everything received as seen; her seen cursor advances and fans out.
    await alice.page.getByTestId('mark-seen').click();
    await expect(alice.page.getByTestId('receipt-view')).toContainText('alice=rs');

    // Bob sees Alice's seen fan out too (he is within broadcastUpTo).
    await expect(bob.page.getByTestId('receipt-view')).toContainText('alice=rs');

    // Server view now reports Alice (and only Alice) as seen past seq 1.
    await alice.page.getByTestId('ask-server-seen').click();
    await expect(alice.page.getByTestId('server-answer')).toHaveText('seen:alice');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('client seenBy/receivedBy round-trip the server and answer authoritatively', async ({
    browser,
  }, testInfo) => {
    const room = `receipts-query-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');
    const carol = await openMember(browser, room, 'carol');

    await alice.page.getByTestId('sub').click();
    await bob.page.getByTestId('sub').click();
    await carol.page.getByTestId('sub').click();
    await expect(alice.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(carol.page.getByTestId('subscribed')).toHaveText('yes');

    await carol.page.getByTestId('send').click();
    await expect(alice.page.getByTestId('messages')).toHaveText('hello');
    await expect(bob.page.getByTestId('messages')).toHaveText('hello');

    // receivedBy(1) round-trips over `__receiptQuery__`; both recipients received.
    await alice.page.getByTestId('query-received').click();
    await expect(alice.page.getByTestId('query-received-result')).toHaveText('alice|bob');

    // seenBy(1) before anyone marks seen: empty.
    await alice.page.getByTestId('query-seen').click();
    await expect(alice.page.getByTestId('query-seen-result')).toHaveText('');

    // Bob marks seen; a fresh seenBy(1) query now returns bob.
    await bob.page.getByTestId('mark-seen').click();
    await expect(bob.page.getByTestId('receipt-view')).toContainText('bob=rs');
    await alice.page.getByTestId('query-seen').click();
    await expect(alice.page.getByTestId('query-seen-result')).toHaveText('bob');

    await alice.close();
    await bob.close();
    await carol.close();
  });
});
