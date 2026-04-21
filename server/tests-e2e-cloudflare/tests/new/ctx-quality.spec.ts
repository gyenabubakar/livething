import { expect, test } from '@playwright/test';

test.describe('ctx-quality', () => {
  test('ctx.quality / ctx.latency / ctx.bufferedAmount return values', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-quality?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('get-quality').click();

    // quality is a non-empty string label (e.g. 'good' / 'poor').
    await expect(page.getByTestId('quality')).not.toHaveText('');
    // latency + bufferedAmount are numeric; zero is valid. Poll for any value.
    await expect(page.getByTestId('latency')).toHaveText(/\d+/);
    await expect(page.getByTestId('buffered')).toHaveText(/\d+/);
  });
});
