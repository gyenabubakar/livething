import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: received (inbox) and read (readReceipts) surfaces against the
// real server definition. Received cursors advance from each member's `__received__` ack
// and fan out as `__received__` frames into the `receivers` store; read cursors
// from markAsRead() fan out as `__read__` frames into the `readers` store.
// `receiversOf`/`readersOf` round-trip to the server, whose authoritative view
// is surfaced via `cursor-answer` and must agree. A dedicated sender (carol)
// publishes: a channel broadcast excludes the sender, so the recipients whose
// cursors advance are exactly the non-sending members.
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

test.describe('receipts (received + read cursors)', () => {
  test('received and read cursors advance, fan out to members, and match the server view', async ({
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

    // Both recipients' received cursors advance and fan out — Alice sees BOTH at seq 1.
    await expect(alice.page.getByTestId('receivers-view')).toHaveText('alice=1,bob=1');
    await expect(alice.page.getByTestId('readers-view')).toHaveText('');

    // The server's authoritative view: exactly the two recipients received seq 1.
    await alice.page.getByTestId('ask-server-received').click();
    await expect(alice.page.getByTestId('server-answer')).toHaveText('received:alice|bob');

    // No one has marked read yet — the server's read set is empty.
    await alice.page.getByTestId('ask-server-read').click();
    await expect(alice.page.getByTestId('server-answer')).toHaveText('read:');

    // Alice marks everything received as read; her read cursor advances and fans out.
    await alice.page.getByTestId('mark-read').click();
    await expect(alice.page.getByTestId('readers-view')).toHaveText('alice=1');
    // The received projection is unchanged.
    await expect(alice.page.getByTestId('receivers-view')).toHaveText('alice=1,bob=1');

    // Bob sees Alice's read fan out too (he is within maxReceiptAudience).
    await expect(bob.page.getByTestId('readers-view')).toContainText('alice=1');

    // Server view now reports Alice (and only Alice) as read past seq 1.
    await alice.page.getByTestId('ask-server-read').click();
    await expect(alice.page.getByTestId('server-answer')).toHaveText('read:alice');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('client readersOf/receiversOf round-trip the server and answer authoritatively', async ({
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

    // receiversOf(1) round-trips over `__receivedQuery__`; both recipients received.
    // Bob's acknowledgement can reach the server after his page shows the
    // message, so ask again until it has.
    await expect(async () => {
      await alice.page.getByTestId('query-received').click();
      await expect(alice.page.getByTestId('query-received-result')).toHaveText('alice|bob', {
        timeout: 1_000,
      });
    }).toPass({ timeout: 10_000 });

    // readersOf(1) before anyone marks read: empty.
    await alice.page.getByTestId('query-read').click();
    await expect(alice.page.getByTestId('query-read-result')).toHaveText('');

    // Bob marks read; a fresh readersOf(1) query now returns bob.
    await bob.page.getByTestId('mark-read').click();
    await expect(bob.page.getByTestId('readers-view')).toContainText('bob=1');
    await alice.page.getByTestId('query-read').click();
    await expect(alice.page.getByTestId('query-read-result')).toHaveText('bob');

    await alice.close();
    await bob.close();
    await carol.close();
  });
});
