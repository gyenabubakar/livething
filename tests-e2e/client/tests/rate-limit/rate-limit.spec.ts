import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client against the real wskit `rate-limit` server definition.
// Adapter-oblivious — it talks to whatever server the run booted over the /ws
// proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/rate-limit/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('rate-limit (conformance)', () => {
  test('spamming a capped event past its cap delivers rate-limited + retryAfterMs to onServerError', async ({
    page,
  }, testInfo) => {
    await open(page, `rl-tick-${testInfo.testId}`);

    // Top-level cap is max=3 in a fresh bucket; the 4th frame breaches it.
    await page.getByTestId('tick').click();
    await page.getByTestId('tick').click();
    await page.getByTestId('tick').click();
    await page.getByTestId('tick').click();

    await expect(page.getByTestId('error-code')).toHaveText('rate-limited');
    const retry = await page.getByTestId('retry-after-ms').textContent();
    expect(Number(retry)).toBeGreaterThanOrEqual(1);
  });

  test('a per-handler override caps one event tighter and still hits onServerError', async ({
    page,
  }, testInfo) => {
    await open(page, `rl-expensive-${testInfo.testId}`);

    // 'expensive' has its own bucket with max=1; the second frame is rejected.
    await page.getByTestId('expensive').click();
    await page.getByTestId('expensive').click();

    await expect(page.getByTestId('error-code')).toHaveText('rate-limited');
  });

  test('a rate-limited request() rejects with code rate-limited', async ({ page }, testInfo) => {
    await open(page, `rl-echo-${testInfo.testId}`);

    // 'echo-req' has a per-handler override max=1: first resolves, second rejects.
    await page.getByTestId('echo-req').click();
    await expect(page.getByTestId('echo-outcome')).toHaveText('ok');

    await page.getByTestId('echo-req').click();
    await expect(page.getByTestId('echo-outcome')).toHaveText('rate-limited');
  });
});
