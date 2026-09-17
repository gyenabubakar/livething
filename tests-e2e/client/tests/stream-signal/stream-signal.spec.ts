import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's stream().cancel() fires the server's
// ctx.stream.signal against the real `stream-signal` server definition. If the signal did
// not work the parked 60s await would never resolve and these assertions would
// time out. Adapter-oblivious — it talks to whatever server the run booted over
// the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/stream-signal/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('stream-signal (conformance)', () => {
  test('ctx.stream.signal fires when the typed client cancels the stream', async ({
    page,
  }, testInfo) => {
    await open(page, `ssig-${testInfo.testId}`);

    await page.getByTestId('start-slow').click();
    await expect(page.getByTestId('chunk-indices')).toHaveText('0');
    await expect(page.getByTestId('stream-id')).not.toHaveText('');

    await page.getByTestId('cancel').click();

    await expect(page.getByTestId('signal-fired')).toHaveText('yes');
    await expect(page.getByTestId('signal-aborted')).toHaveText('yes');
    await expect(page.getByTestId('signal-reason')).toHaveText('cancelled');
    await expect(page.getByTestId('signal-ran-to-completion')).toHaveText('no');
  });
});
