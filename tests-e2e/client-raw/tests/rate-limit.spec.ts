import { expect, test } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

test.describe('rate-limit', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/rate-limit?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('top-level cap allows max then rejects with rate-limited + retryAfterMs', async ({
    page,
  }) => {
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

    const retry = await page.getByTestId('last-retry-after-ms').textContent();
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

  test('metadata.exchange.id is preserved on rate-limited request rejection', async ({ page }) => {
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
      // Distinct usernames keep ctx.user.id distinct too.
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

  test('custom `per` key groups two connections of the same user into one shared budget', async ({
    page,
  }, testInfo) => {
    // 'shared-tick' has a per-handler override: max=2, per: ctx => ctx.meta.username.
    // Two sockets opened with the SAME username resolve to the same bucket key,
    // so they share one budget — unlike the default per-connection (ctx.connection.id)
    // isolation proved by the per-connection-isolation test above.
    const room = `shared-${testInfo.testId}`;
    await page.goto('/rate-limit');
    await installRig(page);

    const a = await connect(page, { path: '/ws/rate-limit', username: 'shared-user', room });
    const b = await connect(page, { path: '/ws/rate-limit', username: 'shared-user', room });

    // A spends the whole shared budget (max=2).
    await send(page, a, { event: 'shared-tick', payload: {} });
    await send(page, a, { event: 'shared-tick', payload: {} });
    await waitForFrame(page, a, {
      match: (f) => f.event === 'shared-done',
    });
    await expect
      .poll(async () => (await frames(page, a)).filter((f) => f.event === 'shared-done').length)
      .toBe(2);

    // B shares A's budget — its first frame is already over the cap.
    await send(page, b, { event: 'shared-tick', payload: {} });
    const err = await waitForFrame(page, b, { match: (f) => f.event === '__error__' });
    expect((err.payload as { code?: string }).code).toBe('rate-limited');

    // B produced no accepted frame: the budget was shared, not per-connection.
    const bShared = (await frames(page, b)).filter((f) => f.event === 'shared-done');
    expect(bShared).toHaveLength(0);
  });

  test('channel scope rule caps the whole channel across its events (shared scope bucket)', async ({
    page,
  }, testInfo) => {
    // 'tight-room' channel declares its own scope rule rateLimit { max: 2 } — not
    // a per-handler override. Its two events ('alpha', 'beta') therefore draw
    // from one channel-scope bucket. Two events of ANY mix pass; the third is
    // rejected, proving the scope cap is enforced across distinct events.
    const room = `tight-${testInfo.testId}`;
    await page.goto('/rate-limit');
    await installRig(page);

    const c = await connect(page, { path: '/ws/rate-limit', username: 'tight-user', room });
    await send(page, c, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'tight-room' } },
    });
    await waitForFrame(page, c, {
      match: (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === 'tight-room',
    });

    // Two frames across two different events both pass (scope bucket max=2).
    await send(page, c, {
      event: 'alpha',
      payload: { text: 'a' },
      metadata: { channel: { name: 'tight-room' } },
    });
    await send(page, c, {
      event: 'beta',
      payload: { text: 'b' },
      metadata: { channel: { name: 'tight-room' } },
    });
    await expect
      .poll(async () => (await frames(page, c)).filter((f) => f.event === 'tight-broadcast').length)
      .toBe(2);

    // Third frame on a third event-call exhausts the shared scope bucket.
    await send(page, c, {
      event: 'alpha',
      payload: { text: 'c' },
      metadata: { channel: { name: 'tight-room' } },
    });
    const err = await waitForFrame(page, c, { match: (f) => f.event === '__error__' });
    expect((err.payload as { code?: string }).code).toBe('rate-limited');

    // Still only two broadcasts: the third event was rejected, not delivered.
    const broadcasts = (await frames(page, c)).filter((f) => f.event === 'tight-broadcast');
    expect(broadcasts).toHaveLength(2);
  });
});
