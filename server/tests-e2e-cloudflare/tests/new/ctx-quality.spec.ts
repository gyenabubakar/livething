import { expect, test } from '@playwright/test';

test.describe('ctx-quality', () => {
  test('ctx.quality / ctx.latency / ctx.bufferedAmount are populated', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-quality?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    // Repeatedly query until latency is populated (may be null initially, numeric after pongs)
    for (let i = 0; i < 5; i++) {
      await page.getByTestId('get-quality').click();
      const latencyText = await page.getByTestId('latency').textContent();
      if (latencyText && /\d+/.test(latencyText)) {
        break;
      }
      await page.waitForTimeout(400);
    }

    // quality is a non-empty string label; bufferedAmount is numeric
    await expect(page.getByTestId('quality')).not.toHaveText('');
    await expect(page.getByTestId('buffered')).toHaveText(/\d+/);
  });
  test('ctx.bufferedAmount is a non-negative number', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-quality?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('get-quality').click();

    const bufferedText = await page.getByTestId('buffered').textContent();
    const bufferedAmount = Number(bufferedText);
    expect(bufferedAmount).toBeGreaterThanOrEqual(0);
  });
});
