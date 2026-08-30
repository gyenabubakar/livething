import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's stream().nudge() against the real wskit
// `stream-nudges` handler. Adapter-oblivious — it talks to whatever server the
// run booted over the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/stream-nudges/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

async function start(page: Page): Promise<void> {
  await page.getByTestId('start').click();
  await expect(page.getByTestId('stream-id')).not.toHaveText('');
  await expect(page.getByTestId('tokens')).not.toHaveText('');
}

test.describe('stream-nudges (conformance)', () => {
  test('a valid pause nudge resolves and steers the generator to stop', async ({
    page,
  }, testInfo) => {
    await open(page, `sn-pause-${testInfo.testId}`);
    await start(page);

    await page.getByTestId('pause').click();
    await expect(page.getByTestId('nudge-ok')).toHaveText('yes');
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
    await expect(page.getByTestId('active')).toHaveText('false');

    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    const wordCount = tokens.trim().split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeLessThan(10);
  });

  test('a valid speed-up nudge resolves and the stream completes naturally', async ({
    page,
  }, testInfo) => {
    await open(page, `sn-speedup-${testInfo.testId}`);
    await start(page);

    await page.getByTestId('speed-up').click();
    await expect(page.getByTestId('nudge-ok')).toHaveText('yes');
    await expect(page.getByTestId('nudge-error')).toHaveText('');
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
    await expect(page.getByTestId('active')).toHaveText('false');
  });

  test('a malformed nudge rejects non-terminally while the stream keeps running', async ({
    page,
  }, testInfo) => {
    await open(page, `sn-malformed-${testInfo.testId}`);
    await start(page);

    await page.getByTestId('malformed-pause').click();
    await expect(page.getByTestId('nudge-error')).toHaveText('validation-failed');

    // The rejected nudge must NOT have ended the stream.
    await expect(page.getByTestId('stream-end')).toHaveText('');
    await expect(page.getByTestId('active')).toHaveText('true');

    // The same connection is still healthy: a valid pause still ends the stream.
    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
  });

  test('a nudge intercept throwing a typed error rejects nudge() but the stream runs to completion', async ({
    page,
  }, testInfo) => {
    await open(page, `sn-reject-${testInfo.testId}`);
    await start(page);

    await page.getByTestId('reject-nudge').click();
    // nudge() rejects with the typed code the intercept threw.
    await expect(page.getByTestId('nudge-error')).toHaveText('nudge-rejected');
    await expect(page.getByTestId('nudge-ok')).toHaveText('');

    // The thrown intercept is non-terminal: the chunk loop runs to the end.
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
    await expect(page.getByTestId('active')).toHaveText('false');

    // All ten words arrived — the stream completed naturally, not cut short.
    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    const wordCount = tokens.trim().split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBe(10);
  });

  test('cancelling the handle ends the stream', async ({ page }, testInfo) => {
    await open(page, `sn-cancel-${testInfo.testId}`);
    await start(page);

    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
    await expect(page.getByTestId('active')).toHaveText('false');
  });

  test('cancelling a held stream releases its generator', async ({ page }, testInfo) => {
    await open(page, `sn-held-cancel-${testInfo.testId}`);

    await page.getByTestId('start-held').click();
    await expect(page.getByTestId('held-stream-id')).not.toHaveText('');
    await expect(page.getByTestId('held-end')).toHaveText('');

    await page.getByTestId('cancel-held').click();
    await expect(page.getByTestId('held-end')).toHaveText('yes');
    await expect(page.getByTestId('held-server-released')).toHaveText('yes');
  });

  test('breaking out of the for-await loop ends the stream', async ({ page }, testInfo) => {
    await open(page, `sn-break-${testInfo.testId}`);

    await page.getByTestId('start-break').click();
    await expect(page.getByTestId('break-end')).toHaveText('false');
  });
});
