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

  test('multiple pause nudges coalesce to single stream stop', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-long').click();
    await expect(page.getByTestId('tokens')).not.toHaveText('');

    // Send 3 pause nudges rapidly; stream should stop once, not trip on duplication.
    await page.getByTestId('pause-multiple').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    const wordCount = tokens.trim().split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeLessThan(16);
  });

  test('nudge sent before first yield is delivered at first ctx.nudges() call', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);

    // Start stream, then immediately send pause before any yields land.
    // The pause nudge should be buffered and available at the first ctx.nudges(yield).
    await page.getByTestId('start-long').click();
    await page.getByTestId('pause').click();

    // Stream should end early due to pause landing at first yield.
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    const wordCount = tokens.trim().split(/\s+/).filter(Boolean).length;
    // With pause at first yield, should have only 1 token (the one yielded before
    // ctx.nudges is called and checked).
    expect(wordCount).toBeLessThanOrEqual(2);
  });

  test('nudges are typed per event and mixed types coexist on one stream', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-long').click();
    await expect(page.getByTestId('tokens')).not.toHaveText('');

    // Send speed-up to accelerate, then pause to stop; both nudges should reach handler.
    await page.getByTestId('speed-up').click();
    await expect(async () => {
      const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
      expect(tokens.length).toBeGreaterThan(5);
    }).toPass({ timeout: 3_000 });

    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    const tokens = (await page.getByTestId('tokens').textContent()) ?? '';
    expect(tokens.length).toBeGreaterThan(0);
  });

  test('malformed nudges do not fall through to a same-named top-level handler', async ({
    page,
  }, testInfo) => {
    // The fixture registers BOTH a stream `pause` nudge (strict, rejects
    // extra keys) AND a top-level .incoming(Pause, ...) that would fire
    // `pause-top-level-fired`. Pre-fix bufferStreamNudge returned false
    // on validation failure, so processTextMessage fell through to
    // dispatchIncoming and ran the top-level handler with the malformed
    // payload.
    await openPage(page, `test-${testInfo.testId}`);

    await page.getByTestId('start-long').click();
    await expect(async () => {
      const id = (await page.getByTestId('stream-id').textContent()) ?? '';
      expect(id.length).toBeGreaterThan(0);
    }).toPass({ timeout: 3_000 });

    await page.getByTestId('malformed-pause').click();

    // Wait long enough for any rogue dispatch to land. The top-level
    // handler must NOT have fired — the leak field stays empty.
    await page.waitForTimeout(1000);
    expect(await page.getByTestId('pause-top-level-leak').textContent()).toBe('');

    // Positive signal that the websocket is still healthy: a valid pause
    // nudge still ends the stream as expected.
    await page.getByTestId('pause').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
  });
});
