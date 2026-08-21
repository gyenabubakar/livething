import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: an unsubscribe() issued while the socket is reconnecting must not
// be lost. The client resends the __unsubscribe__ on reopen, the persistent
// channel does NOT auto-rejoin, and the server records a real leave and confirms
// it with __unsubscribeOk__ (so the unsubscribe() promise resolves). Proof is the
// subscribe-flow count: if the unsubscribe were lost, the persistent channel would
// auto-rejoin on reconnect and the server would run a SECOND subscribe flow. Talks
// to the real `persistence` handler over the /ws proxy.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(
    `/tests/unsubscribe-during-reconnect/index.html?room=${room}&username=${username}`,
  );
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('unsubscribe during reconnect (conformance)', () => {
  test('a leave issued while reconnecting wins: no rejoin, one true leave', async ({
    page,
  }, testInfo) => {
    const room = `unsub-reconnect-${testInfo.testId}`;
    await open(page, room, 'alice');

    // Join the persistent channel; the server runs exactly one subscribe flow.
    await page.getByTestId('sub-archive').click();
    await expect(page.getByTestId('archive-subscribed')).toHaveText('yes');
    await expect(page.getByTestId('subscribe-flows')).toHaveText('1');

    // Drop the socket, wait until reconnecting has actually started, then
    // unsubscribe. The frame is held and must flush on reopen instead of being lost.
    await page.getByTestId('server-drop').click();
    await expect(page.getByTestId('status')).toHaveText('reconnecting');
    await page.getByTestId('unsubscribe').click();

    // The socket comes back open.
    await expect(page.getByTestId('status')).toHaveText('open');

    // The held unsubscribe flushed: onUnsubscribed fired once, the server recorded
    // a real leave (membership removed), and the persistent channel did NOT
    // auto-rejoin — the subscribe-flow count stays at 1.
    await expect(page.getByTestId('unsubscribed')).toHaveText('1');
    await expect(page.getByTestId('true-leaves')).toHaveText('1');
    await expect(page.getByTestId('subscribe-flows')).toHaveText('1');

    // And the client agrees it left: a send fails locally with channel-not-subscribed,
    // even though the server's auto-rejoin confirmation raced in during the reconnect.
    await page.getByTestId('send-after-leave').click();
    await expect(page.getByTestId('send-result')).toHaveText('channel-not-subscribed');

    // The server confirmed the leave with __unsubscribeOk__, so the unsubscribe()
    // promise resolved over the real wire.
    await expect(page.getByTestId('leave-result')).toHaveText('resolved');
  });
});
