import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's channel-scoped stream() / resumeStream() against
// the real `stream-durable-scoped` handler. The `rooms` channel exposes a
// resumable cursor stream (`paginate`) and a recorded stream (`history`), both
// reached through the typed channel handle. Adapter-oblivious — it talks to
// whatever server the run booted over the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/channel-streams/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
  await page.getByTestId('subscribe').click();

  await expect(page.getByTestId('subscribed')).toHaveText('true');
}

test.describe('channel-streams (conformance)', () => {
  test('a channel resumable cursor stream runs to completion', async ({ page }, testInfo) => {
    await open(page, `cs-paginate-${testInfo.testId}`);
    await page.getByTestId('start-paginate').click();

    await expect.poll(() => page.getByTestId('rows-ended').textContent()).toBe('yes');
    const rows = (await page.getByTestId('rows').textContent())!.split(',').map(Number);
    expect(rows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('resumeStream() reattaches a channel stream from its saved cursor', async ({
    page,
  }, testInfo) => {
    await open(page, `cs-resume-${testInfo.testId}`);
    await page.getByTestId('start-paginate').click();
    await expect.poll(() => page.getByTestId('rows-ended').textContent()).toBe('yes');
    await expect(page.getByTestId('rows')).toHaveText('1,2,3,4,5,6,7,8,9,10');

    // The cursor is retained after the stream ends. A manual resume from the saved
    // cursor reattaches and ends cleanly with no new rows.
    await page.getByTestId('resume-paginate').click();
    await expect.poll(() => page.getByTestId('rows-ended').textContent()).toBe('yes');
    await expect(page.getByTestId('rows')).toHaveText('1,2,3,4,5,6,7,8,9,10');
    await expect(page.getByTestId('error-code')).toHaveText('');
  });

  test('a channel recorded stream runs to completion', async ({ page }, testInfo) => {
    await open(page, `cs-history-${testInfo.testId}`);
    await page.getByTestId('start-history').click();

    await expect.poll(() => page.getByTestId('history-ended').textContent()).toBe('yes');
    await expect(page.getByTestId('history')).toHaveText('1,2,3,4,5');
  });
});
