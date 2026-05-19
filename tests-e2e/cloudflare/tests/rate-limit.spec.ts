import { expect, test } from '@playwright/test';

test.describe('rate-limit', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/rate-limit?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('top-level cap allows max then rejects with rate-limited + retryAfter', async ({ page }) => {
    // Cap is max=3 in a fresh bucket.
    await page.getByTestId('tick').click();
    await page.getByTestId('tick').click();
    await page.getByTestId('tick').click();
    await expect(page.getByTestId('tock-count')).toHaveText('3');

    // 4th and 5th should be rejected.
    await page.getByTestId('tick').click();
    await page.getByTestId('tick').click();

    await expect(page.getByTestId('rate-limited-count')).toHaveText('2');
    await expect(page.getByTestId('tock-count')).toHaveText('3');
    await expect(page.getByTestId('last-error-code')).toHaveText('rate-limited');

    const retry = await page.getByTestId('last-retry-after').textContent();
    expect(Number(retry)).toBeGreaterThanOrEqual(1);
  });

  test('per-handler override applies a tighter cap to one event only', async ({ page }) => {
    // 'expensive' has its own bucket with max=1. First passes, second rejected.
    await page.getByTestId('expensive').click();
    await expect(page.getByTestId('expensive-done-count')).toHaveText('1');

    await page.getByTestId('expensive').click();
    await expect(page.getByTestId('rate-limited-count')).toHaveText('1');
    await expect(page.getByTestId('expensive-done-count')).toHaveText('1');

    // Top-level 'tick' bucket is separate (max=3) — still has tokens.
    await page.getByTestId('tick').click();
    await expect(page.getByTestId('tock-count')).toHaveText('1');
  });

  test('channel with rateLimit { enabled: false } is exempt from the top-level cap', async ({
    page,
  }) => {
    await page.getByTestId('subscribe-no-limit').click();
    await expect(page.getByTestId('subscribed-no-limit')).toHaveText('yes');

    // Send many channel events; none should hit the rate-limit error.
    for (let i = 0; i < 10; i += 1) {
      await page.getByTestId('send-no-limit').click();
    }
    await expect(page.getByTestId('no-limit-msg-count')).toHaveText('10');
    await expect(page.getByTestId('rate-limited-count')).toHaveText('0');
  });

  test('namespace cascade applies its own cap; top-level bucket is independent', async ({
    page,
  }) => {
    // Namespace 'strict' has max=2.
    await page.getByTestId('strict-ping').click();
    await page.getByTestId('strict-ping').click();
    await expect(page.getByTestId('strict-pong-count')).toHaveText('2');

    await page.getByTestId('strict-ping').click();
    await expect(page.getByTestId('rate-limited-count')).toHaveText('1');
    await expect(page.getByTestId('strict-pong-count')).toHaveText('2');

    // Top-level bucket (max=3) is separate — three ticks all succeed.
    await page.getByTestId('tick').click();
    await page.getByTestId('tick').click();
    await page.getByTestId('tick').click();
    await expect(page.getByTestId('tock-count')).toHaveText('3');
  });

  test('per-handler override inside a channel scopes the tighter cap to one event', async ({
    page,
  }) => {
    await page.getByTestId('subscribe-rooms').click();
    await expect(page.getByTestId('subscribed-rooms')).toHaveText('yes');

    // 'chatter' inside 'rooms' has its own bucket (max=1).
    await page.getByTestId('send-chatter').click();
    await expect(page.getByTestId('chatter-msg-count')).toHaveText('1');

    await page.getByTestId('send-chatter').click();
    await expect(page.getByTestId('rate-limited-count')).toHaveText('1');
    await expect(page.getByTestId('chatter-msg-count')).toHaveText('1');
  });

  test('channel without rateLimit inherits the top-level cap (shared bucket)', async ({ page }) => {
    await page.getByTestId('subscribe-inherit').click();
    await expect(page.getByTestId('subscribed-inherit')).toHaveText('yes');

    // Top-level cap is max=3. Spend 2 in the inherited channel + 1 top-level.
    await page.getByTestId('send-inherit').click();
    await page.getByTestId('send-inherit').click();
    await page.getByTestId('tick').click();
    await expect(page.getByTestId('inherit-msg-count')).toHaveText('2');
    await expect(page.getByTestId('tock-count')).toHaveText('1');

    // Bucket is now empty — either a channel or a top-level frame is rejected.
    await page.getByTestId('tick').click();
    await expect(page.getByTestId('rate-limited-count')).toHaveText('1');
    await expect(page.getByTestId('tock-count')).toHaveText('1');
  });

  test('_correlationId is preserved on rate-limited request rejection', async ({ page }) => {
    // 'echo-req' has a per-handler override max=1. First request resolves with
    // its correlation id; the second is rejected with `_error rate-limited`
    // carrying the second request's correlation id.
    await page.getByTestId('echo-1').click();
    await expect(page.getByTestId('echo-1-outcome')).toHaveText('ok');

    await page.getByTestId('echo-2').click();
    await expect(page.getByTestId('echo-2-outcome')).toHaveText('rate-limited');
  });

  test('per-connection isolation: hitting cap on one socket does not affect another', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      // Distinct usernames keep ctx.identity distinct too.
      await pageA.goto(`/rate-limit?room=${room}`);
      await pageA.getByTestId('username').fill('user-a');
      await pageA.getByTestId('connect').click();
      await expect(pageA.getByTestId('status')).toHaveText('connected');

      await pageB.goto(`/rate-limit?room=${room}`);
      await pageB.getByTestId('username').fill('user-b');
      await pageB.getByTestId('connect').click();
      await expect(pageB.getByTestId('status')).toHaveText('connected');

      // A exhausts its bucket.
      await pageA.getByTestId('tick').click();
      await pageA.getByTestId('tick').click();
      await pageA.getByTestId('tick').click();
      await pageA.getByTestId('tick').click();
      await expect(pageA.getByTestId('tock-count')).toHaveText('3');
      await expect(pageA.getByTestId('rate-limited-count')).toHaveText('1');

      // B's bucket is untouched.
      await pageB.getByTestId('tick').click();
      await pageB.getByTestId('tick').click();
      await pageB.getByTestId('tick').click();
      await expect(pageB.getByTestId('tock-count')).toHaveText('3');
      await expect(pageB.getByTestId('rate-limited-count')).toHaveText('0');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('bucket refills over time — recovery after waiting for a slot', async ({ page }) => {
    // 'fast-refill' namespace has windowMs=2000, max=2 → one slot per 1000ms.
    await page.getByTestId('fast-ping').click();
    await page.getByTestId('fast-ping').click();
    await expect(page.getByTestId('fast-pong-count')).toHaveText('2');

    // Bucket empty — 3rd rejected.
    await page.getByTestId('fast-ping').click();
    await expect(page.getByTestId('rate-limited-count')).toHaveText('1');
    await expect(page.getByTestId('fast-pong-count')).toHaveText('2');

    // Wait for at least one token to refill.
    await page.waitForTimeout(1200);

    await page.getByTestId('fast-ping').click();
    await expect(page.getByTestId('fast-pong-count')).toHaveText('3');
    await expect(page.getByTestId('rate-limited-count')).toHaveText('1');
  });
});
