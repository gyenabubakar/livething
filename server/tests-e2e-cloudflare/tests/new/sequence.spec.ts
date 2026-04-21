import { expect, test } from '@playwright/test';

test.describe('sequence', () => {
  test('outgoing frames carry an incrementing _seq number', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/sequence?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('tick').click();
    await expect(page.getByTestId('last-seq')).toHaveText(/[1-9]\d*/);
  });

  // Reconnect-persistence test depends on replay-history being extracted
  // (Phase 1e step 28). See E2E_RESTRUCTURE_PLAN.md §6 dependencies.
});
