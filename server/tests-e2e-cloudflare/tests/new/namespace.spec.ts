import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
}

test.describe('namespace', () => {
  test('events sent inside a namespace reach the same connection via ctx.namespace.send', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/namespace?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('send-ns').click();
    await expect(page.getByTestId('ns-message')).toHaveText('hello ns');
  });

  test('ctx.namespace.broadcast sends outgoing events to all connections', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();

    await page1.goto(`/namespace?room=${room}`);
    await page1.getByTestId('connect').click();
    await waitForText(page1, 'status', 'connected');

    await page2.goto(`/namespace?room=${room}`);
    await page2.getByTestId('connect').click();
    await waitForText(page2, 'status', 'connected');

    await page1.getByTestId('broadcast-ns').click();
    await waitForText(page1, 'ns-message', 'broadcast msg');
    await waitForText(page2, 'ns-message', 'broadcast msg');

    await page1.close();
    await page2.close();
  });

  test('stream declared inside a namespace yields chunks and ends normally', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/namespace?room=${room}`);
    await page.getByTestId('connect').click();
    await waitForText(page, 'status', 'connected');

    await page.getByTestId('start-ns-stream').click();
    await expect(page.getByTestId('ns-stream-chunks')).toHaveText('0,1,2');
    await expect(page.getByTestId('ns-stream-end')).toHaveText('yes');
  });

  test('ctx.namespace.name returns the matched namespace name', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/namespace?room=${room}`);
    await page.getByTestId('connect').click();
    await waitForText(page, 'status', 'connected');

    await page.getByTestId('query-ns-name').click();
    await waitForText(page, 'ns-name-result', 'ns');
  });
});
