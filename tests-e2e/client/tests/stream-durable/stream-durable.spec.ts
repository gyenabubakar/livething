import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's stream() / resumeStream() against the real
// `stream-durable` handler. Adapter-oblivious — it talks to whatever server the
// run booted over the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/stream-durable/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('stream-durable (conformance)', () => {
  test('a durable stream auto-resumes on the same handle after an unexpected drop', async ({
    page,
  }, testInfo) => {
    await open(page, `sd-resume-${testInfo.testId}`);

    await page.getByTestId('start-paginate').click();
    await expect
      .poll(async () => Number(await page.getByTestId('row-count').textContent()))
      .toBeGreaterThanOrEqual(2);
    const beforeDrop = Number(await page.getByTestId('row-count').textContent());
    expect(beforeDrop).toBeLessThan(10);

    // Force an UNEXPECTED drop mid-stream. reconnection() reopens the client and
    // stream() resumes the durable stream from its saved cursor; the remaining
    // chunks land on the SAME handle that's still being iterated.
    await page.getByTestId('drop-socket').click();
    await expect(page.getByTestId('status')).toHaveText('open');

    await expect.poll(() => page.getByTestId('ended').textContent()).toBe('yes');
    const order = (await page.getByTestId('rows').textContent())!.split(',').map(Number);
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('resumeStream() manually reattaches to the durable stream', async ({ page }, testInfo) => {
    await open(page, `sd-manual-${testInfo.testId}`);

    await page.getByTestId('start-paginate').click();
    await expect.poll(() => page.getByTestId('ended').textContent()).toBe('yes');
    await expect.poll(() => page.getByTestId('row-count').textContent()).toBe('10');

    // The durable row is retained after the stream ends. A manual resume from the
    // saved cursor reattaches and ends cleanly with no remaining chunks.
    await page.getByTestId('resume-paginate').click();
    await expect.poll(() => page.getByTestId('ended').textContent()).toBe('yes');
    await expect.poll(() => page.getByTestId('row-count').textContent()).toBe('10');
    await expect(page.getByTestId('error-code')).toHaveText('');
  });

  test('resuming an unknown stream id aborts with stream-aborted / not-found', async ({
    page,
  }, testInfo) => {
    await open(page, `sd-unknown-${testInfo.testId}`);

    await page.getByTestId('resume-unknown').click();

    await expect.poll(() => page.getByTestId('error-code').textContent()).toBe('stream-aborted');
    await expect.poll(() => page.getByTestId('error-reason').textContent()).toBe('not-found');
  });
});
