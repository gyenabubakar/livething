import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @livething/client's stream() against the real `stream-backpressure`
// handler. The server awaits ctx.stream.drain() between yields; the typed
// client must receive every chunk and see the stream end cleanly. Adapter-
// oblivious — it talks to whatever server the run booted over the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/stream-backpressure/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('stream-backpressure (conformance)', () => {
  test('a stream that awaits ctx.stream.drain() between yields completes normally', async ({
    page,
  }, testInfo) => {
    await open(page, `sbp-${testInfo.testId}`);
    await page.getByTestId('start-5').click();

    await expect(page.getByTestId('chunk-indices')).toHaveText('0,1,2,3,4');
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
    await expect(page.getByTestId('stream-ok')).toHaveText('yes');
  });
});
