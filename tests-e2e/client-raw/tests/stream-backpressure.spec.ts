import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('stream-backpressure', () => {
  async function openPage(page: Page, room: string, username = 'testuser') {
    await page.goto(`/stream-backpressure?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('a stream that awaits ctx.stream.drain() between yields completes normally', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);

    // The generator yields 5 chunks, calling `await ctx.stream.drain()` after
    // each. On Cloudflare drain is a no-op (the platform exposes no buffer
    // fullness), so the stream must still deliver every chunk and end cleanly —
    // it must NOT hang on drain.
    await page.getByTestId('start-5').click();

    await expect(page.getByTestId('chunk-indices')).toHaveText('0,1,2,3,4');
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
    await expect(page.getByTestId('stream-ok')).toHaveText('yes');
  });
});
