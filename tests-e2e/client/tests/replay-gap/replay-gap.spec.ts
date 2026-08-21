import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: gaps() against the real replay handler, which keeps
// only the newest row per store (maxMessages: 1). A witness publishes while the
// subject is offline, evicting the subject's last-known row and bumping the
// eviction watermark above the subject's lastKnownSeq — the exact condition a
// __gap__ reports. The surviving newest row still arrives after the gap signal.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/replay-gap/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

async function openClient(
  browser: Browser,
  room: string,
  username: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await open(page, room, username);
  return { page, close: () => ctx.close() };
}

test.describe('replay-gap (continuity signal)', () => {
  test('top-level: onGap fires when a missed message was evicted, then the surviving row arrives', async ({
    browser,
  }, testInfo) => {
    const room = `gap-top-${testInfo.testId}`;
    const alice = await openClient(browser, room, 'alice');
    const bob = await openClient(browser, room, 'bob');

    // Alice sees m1 (so she has a top-level seq to replay from).
    await alice.page.getByTestId('send-m1').click();
    await expect(alice.page.getByTestId('messages')).toHaveText('m1');

    await alice.page.getByTestId('drop').click();
    await expect(alice.page.getByTestId('status')).toHaveText('reconnecting');

    // Bob publishes m2 then m3 while Alice is offline. With maxMessages: 1, storing
    // m2 evicts m1, then storing m3 evicts m2 — so the eviction watermark climbs to
    // m2's seq, strictly ABOVE Alice's lastKnownSeq (m1's seq). Two messages are
    // needed: a single eviction would only lift the watermark to Alice's own seq,
    // which is not "below the watermark" and so would (correctly) signal no gap.
    await bob.page.getByTestId('send-m2').click();
    await expect(bob.page.getByTestId('messages')).toContainText('m2');
    await bob.page.getByTestId('send-m3').click();
    await expect(bob.page.getByTestId('messages')).toContainText('m3');

    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('reconnects')).not.toHaveText('0');

    // Alice's __replay__ (lastKnownSeq below the watermark) triggers a __gap__
    // carrying the eviction watermark (a real positive seq, not just "some frame"),
    // and the surviving newest row (m3) still arrives after it.
    await expect(alice.page.getByTestId('gap')).toHaveText(/^[1-9]\d*$/);
    await expect(alice.page.getByTestId('gap-count')).toHaveText('1');
    await expect(alice.page.getByTestId('messages')).toContainText('m3');

    // replay() advanced its cursor before gaps() consumed the frame, so another
    // reconnect does not report the same deleted range again.
    await alice.page.getByTestId('drop').click();
    await expect(alice.page.getByTestId('status')).toHaveText('reconnecting');
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('reconnects')).toHaveText('2');
    await expect(alice.page.getByTestId('gap-count')).toHaveText('1');

    await alice.close();
    await bob.close();
  });

  test('channel: onGap fires on the channel handle for an evicted channel message', async ({
    browser,
  }, testInfo) => {
    const room = `gap-chan-${testInfo.testId}`;
    const alice = await openClient(browser, room, 'alice');
    const bob = await openClient(browser, room, 'bob');

    await alice.page.getByTestId('sub-room').click();
    await bob.page.getByTestId('sub-room').click();
    await expect(alice.page.getByTestId('room-subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('room-subscribed')).toHaveText('yes');

    // Alice sees r1 (so she has a per-channel seq).
    await alice.page.getByTestId('room-r1').click();
    await expect(alice.page.getByTestId('room-messages')).toContainText('r1');

    await alice.page.getByTestId('drop').click();
    await expect(alice.page.getByTestId('status')).toHaveText('reconnecting');

    // Bob publishes r2 then r3 while Alice is offline. maxMessages: 1 evicts r1
    // then r2, lifting the channel watermark to r2's seq — strictly above Alice's
    // lastKnownSeq (r1's seq), so her per-channel __replay__ triggers a gap.
    await bob.page.getByTestId('room-r2').click();
    await expect(bob.page.getByTestId('room-messages')).toContainText('r2');
    await bob.page.getByTestId('room-r3').click();
    await expect(bob.page.getByTestId('room-messages')).toContainText('r3');

    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('reconnects')).not.toHaveText('0');

    // The channel gap reaches room.onGap (carrying a real positive watermark seq),
    // NOT the top-level onGap, and the surviving channel row (r3) still arrives after.
    await expect(alice.page.getByTestId('room-gap')).toHaveText(/^[1-9]\d*$/);
    await expect(alice.page.getByTestId('room-gap-count')).toHaveText('1');
    await expect(alice.page.getByTestId('gap')).toHaveText('');
    await expect(alice.page.getByTestId('room-messages')).toContainText('r3');

    await alice.page.getByTestId('drop').click();
    await expect(alice.page.getByTestId('status')).toHaveText('reconnecting');
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('reconnects')).toHaveText('2');
    await expect(alice.page.getByTestId('room-gap-count')).toHaveText('1');

    await alice.close();
    await bob.close();
  });
});
