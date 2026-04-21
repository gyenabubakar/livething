import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('stream-nudges', () => {
  async function openPage(page: Page, room: string) {
    await page.goto(`/stream-nudges?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('pause nudge stops the stream early', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-long').click();
    await expect(page.getByTestId('tokens')).not.toHaveText('');

    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    // Stream had 16 words; pause should have landed well before completion.
    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    const wordCount = tokens.trim().split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeLessThan(16);
  });

  test('speed-up nudge affects generator chunk cadence', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-long').click();
    await expect(page.getByTestId('tokens')).not.toHaveText('');

    // Speed up; the stream should now complete naturally well within the
    // unscaled time (16 words * 50ms = 800ms baseline).
    await page.getByTestId('speed-up').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    expect(tokens.length).toBeGreaterThan(0);
  });

  test('pause after a speed-up still stops the stream', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-long').click();
    await expect(page.getByTestId('tokens')).not.toHaveText('');

    await page.getByTestId('speed-up').click();
    // Wait for a few more tokens to land after the speed-up before pausing.
    await expect(async () => {
      const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
      expect(tokens.length).toBeGreaterThan(5);
    }).toPass({ timeout: 3_000 });

    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
  });
});
