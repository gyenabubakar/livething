import { expect, test } from '@playwright/test';

// Sends made while down are queued and flushed on connect.
test('buffers a send made while disconnected and flushes it on connect', async ({
  page,
}, testInfo) => {
  await page.goto(`/?path=echo&room=${testInfo.testId}&buffering=1`);

  // Not connected yet — the send must be queued, not dropped.
  await expect(page.getByTestId('state')).toHaveText('closed');
  await page.getByTestId('send-hello').click();
  await expect(page.getByTestId('last-event')).toHaveText('');

  // Connect → the buffer flushes → the server finally receives and echoes it.
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('state')).toHaveText('open');
  await expect(page.getByTestId('last-event')).toHaveText('echoed');
  await expect(page.getByTestId('last-payload')).toContainText('hi');
});
