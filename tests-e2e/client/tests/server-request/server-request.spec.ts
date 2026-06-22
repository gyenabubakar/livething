import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's serverRequest() against the real `server-request`
// handler. The server asks the client `ask-permission`; the typed onRequest()
// answers, and the server reports the outcome. Adapter-oblivious — it talks to
// whatever server the run booted over the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/server-request/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('server-request (conformance)', () => {
  test('the client answers and the server resolves with the typed answer', async ({
    page,
  }, testInfo) => {
    await open(page, `sreq-ok-${testInfo.testId}`);
    await page.getByTestId('answer-good').click();
    await page.getByTestId('trigger').click();

    await expect(page.getByTestId('ask-action')).toHaveText('delete');
    await expect(page.getByTestId('outcome')).toHaveText('true');
  });

  test('an answer that fails the response schema rejects with request-invalid-response', async ({
    page,
  }, testInfo) => {
    await open(page, `sreq-bad-${testInfo.testId}`);
    await page.getByTestId('answer-bad').click();
    await page.getByTestId('trigger').click();

    await expect(page.getByTestId('ask-action')).toHaveText('delete');
    await expect(page.getByTestId('error-outcome')).toHaveText('request-invalid-response');
  });

  test('no answer before the timeout rejects with timeout', async ({ page }, testInfo) => {
    await open(page, `sreq-drop-${testInfo.testId}`);
    await page.getByTestId('answer-drop').click();
    await page.getByTestId('trigger-timeout').click();

    await expect(page.getByTestId('ask-action')).toHaveText('slow');
    await expect(page.getByTestId('error-outcome')).toHaveText('timeout');
  });
});
