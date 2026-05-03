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

  test('pre-intercept returning void passes message through unchanged', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-top-passthrough').click();
    await expect(page.getByTestId('echoed')).toContainText('top:top-passthrough');
  });

  test('post-intercept returning void passes payload through unchanged', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-top-post-passthrough').click();
    await expect(page.getByTestId('echoed')).toContainText('top:top-post-passthrough');
  });

  test('namespace pre-intercept Block prevents the handler from running', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-ns-pre-block').click();
    // Give the blocked frame time to not produce any reply.
    await page.waitForTimeout(200);
    await expect(page.getByTestId('echoed')).toHaveText('');
    // Positive signal: a normal ns-pre rewrite still works after a block.
    await page.getByTestId('send-ns-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('ns:ns-pre-rewritten');
  });

  test('channel pre-intercept Block prevents the handler from running', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');
    await page.getByTestId('send-ch-pre-block').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('echoed')).toHaveText('');
    // Positive signal: a normal ch-pre rewrite still works after a block.
    await page.getByTestId('send-ch-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('ch:ch-pre-rewritten');
  });

  test('post-intercept Block throws and prevents handler execution', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-top-post-block').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('echoed')).toHaveText('');
    await page.getByTestId('send-top-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('top:top-pre-rewritten');
  });

  test('a frame with both _namespace and _channel is rejected with invalid-scope-markers', async ({
    page,
  }, testInfo) => {
    // Pre-fix the engine returned the namespace branch as soon as
    // _namespace was present, silently ignoring _channel. A client could
    // bypass channel-membership rules by stamping both markers on the
    // same frame.
    await openPage(page, `test-${testInfo.testId}`);
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'echo',
          payload: { text: 'mixed', _namespace: 'ns', _channel: 'room' },
        }),
      );
    });
    await expect(page.getByTestId('last-error-code')).toHaveText('invalid-scope-markers');
    // Connection still healthy: a normal ns frame still works after the rejection.
    await page.getByTestId('send-ns-pre').click();
    await expect(page.getByTestId('echoed')).toContainText('ns:ns-pre-rewritten');
  });
});
