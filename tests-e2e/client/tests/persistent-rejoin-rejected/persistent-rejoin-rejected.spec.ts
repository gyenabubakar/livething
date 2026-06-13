import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Regression for the "permanent state divergence" bug: when the server rejects a
// persistent channel's auto-rejoin on reconnect (revalidate throws), it drops
// the durable membership and sends `rejoin-rejected`. The client must clear the
// channel's `active` state — otherwise it keeps "sending" into a channel the
// server doesn't have it in, and never re-establishes membership (it skips
// re-subscribing active+persistent channels while the server has no row).
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/persistent-rejoin-rejected/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('persistent channel — rejected reconnect rejoin', () => {
  test('a rejoin-rejected clears the channel so send() throws (no permanent active divergence)', async ({
    page,
  }, testInfo) => {
    await open(page, `rejoin-rejected-${testInfo.testId}`, 'alice');

    // Subscribe to the persistent channel (the first-subscribe check passes).
    await page.getByTestId('sub').click();
    await expect(page.getByTestId('on-subscribed')).toHaveText('1');

    // Ban this identity, then force a warm reconnect. On rejoin the revalidate
    // hook sees the ban and throws → the server drops the durable row and sends
    // a `rejoin-rejected` __error__.
    await page.getByTestId('ban').click();
    await page.getByTestId('drop').click();
    await expect(page.getByTestId('status')).toHaveText('reconnecting');
    await expect(page.getByTestId('status')).toHaveText('open');

    // The client is told the rejoin was rejected.
    await expect(page.getByTestId('sub-failed')).toHaveText('1');
    await expect(page.getByTestId('fail-code')).toHaveText('rejoin-rejected');

    // The channel must now be unsubscribed: send() throws ChannelNotSubscribed.
    // Pre-fix the client kept it `active`, so this returned 'sent'.
    await page.getByTestId('try-send').click();
    await expect(page.getByTestId('send-result')).toHaveText('threw:channel-not-subscribed');
  });
});
