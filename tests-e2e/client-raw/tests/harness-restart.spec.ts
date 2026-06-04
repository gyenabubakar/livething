import { expect, test } from '@playwright/test';

// Smoke test for the test-harness restart RPC (`/ws/<feature>/restart` →
// ctx.abort()). It proves the abort actually discards the Durable Object's
// in-memory state — not just that the route returns 204.
//
// The sequence handler uses a NON-persistent (in-memory) seq counter. If
// restart() truly resets the DO, a fresh instance starts the counter over, so
// the seq drops below its pre-restart value. If restart were a no-op (the same
// live instance kept around), the counter would keep climbing instead — and the
// final poll would time out. So a strictly-lower seq after restart is the proof.
test.describe('harness: DO restart (ctx.abort)', () => {
  test('restart discards in-memory state — sequence counter restarts', async ({
    page,
    request,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/sequence?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    // Climb the in-memory counter to at least 3.
    let beforeSeq = 0;
    for (let i = 0; i < 3; i++) {
      await page.getByTestId('tick').click();
      await expect
        .poll(async () => Number((await page.getByTestId('last-seq').textContent()) || '0'))
        .toBeGreaterThan(beforeSeq);
      beforeSeq = Number((await page.getByTestId('last-seq').textContent()) || '0');
    }
    expect(beforeSeq).toBeGreaterThanOrEqual(3);

    // Restart the DO: ctx.abort() tears down the in-memory instance (and the
    // socket); durable storage survives. The RPC rejects mid-abort, so the
    // route swallows it and returns 204.
    const res = await request.get(`/ws/sequence/restart?room=${room}`);
    expect(res.status()).toBe(204);

    // The abort closed the socket — wait for the page to observe it.
    await expect(page.getByTestId('status')).toHaveText('disconnected');

    // Reconnect to the SAME room (same DO id → a fresh post-abort instance) and
    // tick. The page keeps its stale last-seq until the new tock arrives, so we
    // poll until it drops below the pre-restart value: that only happens once a
    // reset counter (starting back at 1) stamps the new frame.
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
    await page.getByTestId('tick').click();
    await expect
      .poll(async () => Number((await page.getByTestId('last-seq').textContent()) || '0'))
      .toBeLessThan(beforeSeq);
  });
});
