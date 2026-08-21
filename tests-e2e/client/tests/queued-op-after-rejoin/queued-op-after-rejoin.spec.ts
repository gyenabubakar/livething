import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: the reconnect ordering fix. A channel send queued while the socket
// is reconnecting must reach the server only AFTER the persistent channel is
// rejoined. A witness client receiving the broadcast proves the send arrived
// post-rejoin (otherwise the server would drop it as ChannelNotSubscribed). Talks
// to the real `persistence` handler over the /ws proxy.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/queued-op-after-rejoin/index.html?room=${room}&username=${username}`);
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

test.describe('queued op after rejoin (conformance)', () => {
  test('a channel send queued during reconnect reaches the server after rejoin', async ({
    browser,
  }, testInfo) => {
    const room = `queued-rejoin-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await alice.page.getByTestId('sub-archive').click();
    await bob.page.getByTestId('sub-archive').click();
    await expect(alice.page.getByTestId('archive-subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('archive-subscribed')).toHaveText('yes');

    // Hold Alice's replacement connection before it opens, then queue a channel
    // send. Buffering holds it; on reopen the rejoin runs first, then the buffered
    // send flushes — so the server accepts it and broadcasts it.
    await alice.page.getByTestId('server-drop').click();
    await expect(alice.page.getByTestId('reconnect-held')).toHaveText('yes');
    await alice.page.getByTestId('queued-send').click();
    await alice.page.getByTestId('resume-reconnect').click();

    await expect(alice.page.getByTestId('status')).toHaveText('open');

    // Bob receives the broadcast — proof the queued send reached the server after
    // alice's channel was rejoined.
    await expect(bob.page.getByTestId('room-messages')).toContainText('alice:queued-after-rejoin');

    await alice.close();
    await bob.close();
  });
});
