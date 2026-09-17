import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's socket.onServerError against the real wskit
// `errors-factory` server definition. Adapter-oblivious — it talks to whatever server the
// run booted over the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/errors-factory/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('errors-factory (conformance)', () => {
  test('a registered server error arrives on onServerError with its code and detail', async ({
    page,
  }, testInfo) => {
    await open(page, `err-notfound-${testInfo.testId}`);
    await page.getByTestId('trigger-not-found').click();
    await expect(page.getByTestId('error-code')).toHaveText('not-found');
    await expect(page.getByTestId('error-result')).toContainText('test-123');
  });

  test('a second registered error works on onServerError', async ({ page }, testInfo) => {
    await open(page, `err-forbidden-${testInfo.testId}`);
    await page.getByTestId('trigger-forbidden').click();
    await expect(page.getByTestId('error-code')).toHaveText('forbidden');
    await expect(page.getByTestId('error-result')).toContainText('Access denied');
  });

  test('a code-specific server error listener only fires for its declared code', async ({
    page,
  }, testInfo) => {
    await open(page, `err-code-specific-${testInfo.testId}`);
    await page.getByTestId('trigger-not-found').click();
    await expect(page.getByTestId('specific-error-code')).toHaveText('not-found');
    await expect(page.getByTestId('specific-error-detail')).toHaveText('test-123');
    await expect(page.getByTestId('unmatched-specific-error')).toHaveText('');
  });

  test('a code-only server error delivers its code with empty detail', async ({
    page,
  }, testInfo) => {
    await open(page, `err-simple-${testInfo.testId}`);
    await page.getByTestId('trigger-simple').click();
    await expect(page.getByTestId('error-result')).toHaveText('simple-error:{}');
  });

  test('an undeclared server error is coerced to internal-error', async ({ page }, testInfo) => {
    await open(page, `err-unregistered-${testInfo.testId}`);
    await page.getByTestId('trigger-unregistered').click();
    await expect(page.getByTestId('error-code')).toHaveText('internal-error');
    await expect(page.getByTestId('error-result')).not.toContainText(
      'this error is not registered',
    );
    await expect(page.getByTestId('status')).toHaveText('open');
  });

  test('an unserializable server error detail is coerced to internal-error', async ({
    page,
  }, testInfo) => {
    await open(page, `err-bigint-${testInfo.testId}`);
    await page.getByTestId('trigger-bigint').click();
    await expect(page.getByTestId('error-code')).toHaveText('internal-error');

    // The connection survives the failed serialization — a normal trigger right
    // after must still deliver its error frame.
    await page.getByTestId('trigger-not-found').click();
    await expect(page.getByTestId('error-code')).toHaveText('not-found');
  });
});
