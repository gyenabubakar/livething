import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('intercept', () => {
  async function openPage(page: Page, room: string) {
    await page.goto(`/intercept?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('top-level pre-intercept rewrites the payload before the handler runs', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-top-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('top:top-pre-rewritten');
  });

  test('top-level post-intercept (typed) rewrites the payload before the handler runs', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-top-post').click();
    await expect(page.getByTestId('echoed')).toContainText('top:top-post-rewritten');
  });

  test('namespace pre-intercept rewrites within the namespace scope', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-ns-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('ns:ns-pre-rewritten');
  });

  test('namespace post-intercept rewrites within the namespace scope', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-ns-post').click();
    await expect(page.getByTestId('echoed')).toContainText('ns:ns-post-rewritten');
  });

  test('channel pre-intercept rewrites within the channel scope', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('send-ch-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('ch:ch-pre-rewritten');
  });

  test('channel post-intercept rewrites within the channel scope', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('send-ch-post').click();
    await expect(page.getByTestId('echoed')).toContainText('ch:ch-post-rewritten');
  });
});
