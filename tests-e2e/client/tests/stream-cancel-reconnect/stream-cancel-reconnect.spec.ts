import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: a cancel() issued while the socket is reconnecting must not be
// lost. The client holds __streamCancel__ until reopen, suppresses the durable
// stream's auto-resume, and the server deletes the durable row — proven by a
// later resumeStream() of the same id aborting with not-found. Talks to the real
// `stream-durable` server definition over the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/stream-cancel-reconnect/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('stream cancel during reconnect (conformance)', () => {
  test('a cancel issued while reconnecting deletes the durable row', async ({ page }, testInfo) => {
    await open(page, `stream-cancel-${testInfo.testId}`);

    // Start a durable stream and collect at least one row so the row exists.
    await page.getByTestId('start-paginate').click();
    await expect.poll(() => page.getByTestId('rows').textContent()).not.toBe('');

    // Drop the socket and IMMEDIATELY cancel while reconnecting — the cancel frame
    // is held and must flush on reopen instead of being lost.
    await page.getByTestId('server-drop').click();
    await page.getByTestId('cancel').click();

    // The socket reconnects; the held cancel flushes and the stream ends cleanly
    // (no error from the cancel).
    await expect(page.getByTestId('status')).toHaveText('open');
    await expect(page.getByTestId('error-code')).toHaveText('');

    // Resuming the cancelled id now aborts not-found — the durable row is gone.
    await page.getByTestId('resume-paginate').click();
    await expect
      .poll(() => page.getByTestId('resume-error-code').textContent())
      .toBe('stream-aborted');
    await expect
      .poll(() => page.getByTestId('resume-error-reason').textContent())
      .toBe('not-found');
  });
});
