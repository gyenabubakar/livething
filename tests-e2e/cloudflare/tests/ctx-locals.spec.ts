import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('ctx-locals', () => {
  async function openPage(page: Page, room: string) {
    await page.goto(`/ctx-locals?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('top-level intercept provides a value the handler can inject', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-echo').click();
    // TopKey provided by top intercept → 'top'
    // NsKey not provided at this point (ns intercept never ran) → 'none'
    await expect(page.getByTestId('echoed')).toHaveText('hello:top:none');
  });

  test('top-level provide is visible inside a namespace handler; namespace provide adds its value', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-ns-echo').click();
    // Top intercept ran first → TopKey = 'top'
    // Ns intercept ran next → NsKey = 'ns'
    await expect(page.getByTestId('echoed')).toHaveText('hello:top:ns');
  });

  test('two separate dispatches have isolated locals', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);

    await page.getByTestId('send-echo').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello:top:none');

    // Second dispatch — NsKey is still not visible at top level
    await page.getByTestId('send-echo').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello:top:none');
  });
});
