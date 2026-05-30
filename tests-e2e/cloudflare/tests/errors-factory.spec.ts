import { expect, test } from '@playwright/test';

test.describe('errors-factory', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/errors-factory?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('throwing a registered error delivers it on the _error channel', async ({ page }) => {
    await page.getByTestId('trigger-not-found').click();
    await expect(page.getByTestId('error-result')).toContainText('not-found');
    await expect(page.getByTestId('error-result')).toContainText('test-123');
  });

  test('a second registered error factory works the same way', async ({ page }) => {
    await page.getByTestId('trigger-forbidden').click();
    await expect(page.getByTestId('error-result')).toContainText('forbidden');
    await expect(page.getByTestId('error-result')).toContainText('Access denied');
  });

  test('non-serializable error detail (BigInt) is not crashed; client gets internal-error', async ({
    page,
  }) => {
    await page.getByTestId('trigger-bigint').click();
    await expect(page.getByTestId('error-result')).toContainText('internal-error');

    // Sanity: the connection is still alive after the failed serialization.
    // A normal trigger right after must still deliver its error frame.
    await page.getByTestId('trigger-not-found').click();
    await expect(page.getByTestId('error-result')).toContainText('not-found');
  });

  test('a code-only error (no detail schema) delivers code with empty detail', async ({ page }) => {
    await page.getByTestId('trigger-simple').click();
    // error-result is `${code}:${JSON.stringify(detail ?? {})}` — a code-only
    // error has no detail, so the detail half is `{}`.
    await expect(page.getByTestId('error-result')).toHaveText('simple-error:{}');
  });

  test('an undeclared typed error still delivers its frame (code + detail)', async ({ page }) => {
    // `unregistered` is NOT in the contract's errors:[...]. The engine logs a
    // warning but still delivers the frame with the thrown code and detail —
    // an unknown-but-thrown WSKitError is not swallowed or coerced.
    await page.getByTestId('trigger-unregistered').click();
    await expect(page.getByTestId('error-result')).toContainText('unregistered');
    await expect(page.getByTestId('error-result')).toContainText('this error is not registered');
    // The connection survives an undeclared-error throw.
    await expect(page.getByTestId('status')).toHaveText('connected');
  });
});
