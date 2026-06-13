import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: a request that is buffered while the socket is reconnecting and
// then times out must NOT be sent when the socket reopens. The server records a
// real execution in a durable counter, so the proof is the counter staying at 0:
// without the ownership rule the buffered frame would flush and the server would
// run it after the caller was already told it failed. Talks to the real
// `persistence` handler over the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/buffered-op-timeout/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('buffered op timeout (conformance)', () => {
  test('a buffered request that times out is not executed after reconnect', async ({
    page,
  }, testInfo) => {
    await open(page, `buffered-timeout-${testInfo.testId}`);

    // Drop the socket; once it is reconnecting, fire a request with a short
    // timeout so it buffers and then times out before the reconnect flush.
    await page.getByTestId('server-drop').click();
    await expect(page.getByTestId('status')).not.toHaveText('open');
    await page.getByTestId('record-exec').click();

    // The request rejected with a timeout while buffered.
    await expect(page.getByTestId('record-result')).toHaveText('timeout');

    // The socket comes back open.
    await expect(page.getByTestId('status')).toHaveText('open');

    // The server never ran record-exec: the durable counter is still 0.
    await page.getByTestId('read-count').click();
    await expect(page.getByTestId('exec-count')).toHaveText('0');
  });
});
