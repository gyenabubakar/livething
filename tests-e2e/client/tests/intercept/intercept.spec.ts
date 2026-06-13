import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's intercept() against the real wskit `intercept`
// handler. Adapter-oblivious — it talks to whatever server the run booted over
// the /ws proxy. The client sends `echo`; the server's `echoed` reply is the
// incoming frame the client-side intercepts transform before on() sees it.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/intercept/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('intercept (conformance)', () => {
  test('an intercept that rewrites an incoming payload is what on() sees', async ({
    page,
  }, testInfo) => {
    await open(page, `int-rewrite-${testInfo.testId}`);
    await page.getByTestId('send-rewrite').click();
    await expect(page.getByTestId('echoed')).toHaveText('rewritten-by-client');
  });

  test('an intercept that throws Block drops the frame so on() never fires', async ({
    page,
  }, testInfo) => {
    await open(page, `int-block-${testInfo.testId}`);
    await page.getByTestId('send-block').click();
    // Give the blocked frame time to not surface in on('echoed').
    await page.waitForTimeout(200);
    await expect(page.getByTestId('echoed')).toHaveText('');
    // Positive signal: a normal frame still reaches on() after a block.
    await page.getByTestId('send-pass').click();
    await expect(page.getByTestId('echoed')).toHaveText('top:pass-me');
  });

  test('intercepts run in declaration order', async ({ page }, testInfo) => {
    await open(page, `int-order-${testInfo.testId}`);
    await page.getByTestId('send-order').click();
    await expect(page.getByTestId('echoed')).toHaveText('top:order-me-1-2');
  });

  test('an intercept returning void passes the frame through unchanged', async ({
    page,
  }, testInfo) => {
    await open(page, `int-pass-${testInfo.testId}`);
    await page.getByTestId('send-pass').click();
    await expect(page.getByTestId('echoed')).toHaveText('top:pass-me');
  });
});
