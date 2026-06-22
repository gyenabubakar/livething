import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('stream-signal', () => {
  async function openPage(page: Page, room: string, username = 'testuser') {
    await page.goto(`/stream-signal?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('ctx.stream.signal fires when the client cancels the stream', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);

    // The generator yields one chunk, then awaits a 60s timer wired to
    // ctx.stream.signal. Wait until it is parked on that timer.
    await page.getByTestId('start-slow').click();
    await expect(page.getByTestId('chunk-indices')).toHaveText('0');
    await expect(page.getByTestId('stream-id')).not.toHaveText('');

    // Cancel. If the signal works, the parked 60s await is interrupted at once,
    // the timer is cleared, and the abort path emits `signal-fired`. If it did
    // NOT work, this assertion would time out long before 60s elapsed.
    await page.getByTestId('cancel').click();

    await expect(page.getByTestId('signal-fired')).toHaveText('yes');
    await expect(page.getByTestId('signal-aborted')).toHaveText('yes');
    await expect(page.getByTestId('signal-reason')).toHaveText('cancelled');
    // The 60s timer never resolved — the slow work was aborted, not run out.
    await expect(page.getByTestId('signal-ran-to-completion')).toHaveText('no');
  });
});
