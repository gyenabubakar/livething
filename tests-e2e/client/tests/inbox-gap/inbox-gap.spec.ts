import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: inbox OVERFLOW surfacing against the real inbox-gap handler
// (retention keeps one undelivered row per member). A member offline across two
// broadcasts loses the first held row to eviction; on reconnect the drain emits a
// `__gap__` before the surviving row. This is where the D1 decision bites: only a
// client running replay() consumes `__gap__` and fires onGap — an inbox-only
// client consumes and acknowledges the frame internally, so overflow is hidden
// from application code.
interface MemberOptions {
  room: string;
  username: string;
  withReplay: boolean;
}

async function open(page: Page, options: MemberOptions): Promise<void> {
  const { room, username, withReplay } = options;
  const replayParam = withReplay ? '&replay=1' : '';
  await page.goto(`/tests/inbox-gap/index.html?room=${room}&username=${username}${replayParam}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

async function openMember(
  browser: Browser,
  options: MemberOptions,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await open(page, options);
  return { page, close: () => ctx.close() };
}

test.describe('inbox-gap (overflow surfacing / D1)', () => {
  test('a replay() client surfaces the overflow gap on room.onGap, then the surviving row arrives', async ({
    browser,
  }, testInfo) => {
    const room = `inbox-gap-replay-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice', withReplay: true });
    const bob = await openMember(browser, { room, username: 'bob', withReplay: true });
    const carol = await openMember(browser, { room, username: 'carol', withReplay: true });

    await alice.page.getByTestId('sub').click();
    await bob.page.getByTestId('sub').click();
    await carol.page.getByTestId('sub').click();
    await expect(alice.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(carol.page.getByTestId('subscribed')).toHaveText('yes');

    // Alice goes offline, then Bob publishes two messages. With one undelivered row
    // kept per member, m2 evicts Alice's held m1 and lifts her overflow watermark.
    // Carol stays online as a witness (the sender does not witness its own broadcast).
    await alice.page.getByTestId('disconnect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('closed');
    await bob.page.getByTestId('send-m1').click();
    await bob.page.getByTestId('send-m2').click();
    await expect(carol.page.getByTestId('messages')).toHaveText('m1,m2');

    // On reconnect the drain emits the gap (a real positive watermark seq) before
    // the surviving row (m2). m1 is gone — that is the point of an overflow gap.
    await alice.page.getByTestId('connect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('gap')).toHaveText(/^[1-9]\d*$/);
    await expect(alice.page.getByTestId('messages')).toHaveText('m2');

    // inbox() acknowledges both the surviving row and the overflow watermark on
    // the real wire. A second reconnect must not replay the same gap.
    await alice.page.getByTestId('disconnect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('closed');
    await alice.page.getByTestId('connect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('gap-count')).toHaveText('1');
    await expect(alice.page.getByTestId('message-count')).toHaveText('1');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('an inbox-only client (no replay) hides the overflow gap but still gets the surviving row [D1]', async ({
    browser,
  }, testInfo) => {
    const room = `inbox-gap-only-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice', withReplay: false });
    const bob = await openMember(browser, { room, username: 'bob', withReplay: false });
    const carol = await openMember(browser, { room, username: 'carol', withReplay: false });

    await expect(alice.page.getByTestId('variant')).toHaveText('inbox-only');

    await alice.page.getByTestId('sub').click();
    await bob.page.getByTestId('sub').click();
    await carol.page.getByTestId('sub').click();
    await expect(alice.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(carol.page.getByTestId('subscribed')).toHaveText('yes');

    await alice.page.getByTestId('disconnect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('closed');
    await bob.page.getByTestId('send-m1').click();
    await bob.page.getByTestId('send-m2').click();
    await expect(carol.page.getByTestId('messages')).toHaveText('m1,m2');

    await alice.page.getByTestId('connect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('open');

    // The surviving row still arrives — guaranteed delivery of what was kept.
    await expect(alice.page.getByTestId('messages')).toHaveText('m2');

    // inbox consumes and acknowledges `__gap__`, but without replay() no gap is
    // surfaced to application code. This documents the current (D1) behavior.
    await alice.page.waitForTimeout(400);
    await expect(alice.page.getByTestId('gap')).toHaveText('');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('a late unsubscribe confirmation after rejoin does not disable later inbox acknowledgements', async ({
    browser,
  }, testInfo) => {
    const room = `inbox-gap-stale-unsubscribe-${testInfo.testId}`;
    const alice = await openMember(browser, { room, username: 'alice', withReplay: false });
    const bob = await openMember(browser, { room, username: 'bob', withReplay: false });
    const carol = await openMember(browser, { room, username: 'carol', withReplay: false });

    await alice.page.getByTestId('sub').click();
    await bob.page.getByTestId('sub').click();
    await carol.page.getByTestId('sub').click();
    await expect(alice.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('subscribed')).toHaveText('yes');
    await expect(carol.page.getByTestId('subscribed')).toHaveText('yes');

    // Alice receives and acknowledges the first message while the inbox scope
    // is unquestionably active.
    await bob.page.getByTestId('send-m1').click();
    await expect(alice.page.getByTestId('messages')).toHaveText('m1');

    // The client queues subscribe() behind the explicit leave. Once it resolves,
    // the channel is live again; the server test seam then sends a channel-scoped
    // __unsubscribeOk__ with no matching leave id, which is stale on the wire.
    await alice.page.getByTestId('leave-rejoin').click();
    await expect(alice.page.getByTestId('rejoined')).toHaveText('yes');
    await alice.page.getByTestId('send-stale-unsubscribe-ok').click();

    // A later inbox delivery must still be acknowledged. If the stale frame had
    // cleared inbox state, m2 would be delivered again after the reconnect below.
    await bob.page.getByTestId('send-m2').click();
    await expect(alice.page.getByTestId('messages')).toHaveText('m1,m2');

    await alice.page.getByTestId('disconnect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('closed');
    await alice.page.getByTestId('connect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('message-count')).toHaveText('2');

    await alice.close();
    await bob.close();
    await carol.close();
  });
});
