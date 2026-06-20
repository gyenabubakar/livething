import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

interface GoConnectOptions {
  room: string;
  streamId: string;
  username?: string;
}

async function goConnect(page: Page, opts: GoConnectOptions) {
  const username = opts.username ?? 'ds-user';
  await page.goto(`/stream-durable?room=${opts.room}`);
  await page.getByTestId('username').fill(username);
  await page.getByTestId('stream-id').fill(opts.streamId);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('connected');
}

test.describe('stream-durable', () => {
  test('recorded stream: chunks buffered in storage replay on resume', async ({
    page,
  }, testInfo) => {
    const room = `sdb-${testInfo.testId}-${Date.now()}`;
    const streamId = 'conv-1';
    await goConnect(page, { room: room, streamId: streamId });

    // Run the full stream to completion. Buffer table has all 5 chunks.
    await page.getByTestId('start-count-tokens').click();
    await expect.poll(() => page.getByTestId('stream-end-count').textContent()).toBe('1');
    await expect.poll(() => page.getByTestId('token-chunk-count').textContent()).toBe('5');

    // Drop the socket, reconnect, and resume claiming we only saw chunks 1..2.
    // Server replays chunks 3..5 from the durable buffer, then sends _streamEnd.
    await page.getByTestId('drop-socket').click();
    await expect(page.getByTestId('status')).toHaveText('disconnected');

    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
    await page.getByTestId('since').fill('2');
    await page.getByTestId('send-resume').click();

    // The page state was reset on reconnect (token-chunks not auto-cleared by
    // the page; we want to verify NEW chunks arrive). The replayed chunks
    // append to whatever's on the page; since the page hadn't cleared, it now
    // shows 5 + 3 = 8 entries total.
    await expect
      .poll(async () => Number(await page.getByTestId('token-chunk-count').textContent()))
      .toBe(5 + 3);
    await expect.poll(() => page.getByTestId('stream-end-count').textContent()).toBe('2');
  });

  test('resumable stream: generator re-runs from saved cursor on resume', async ({
    page,
  }, testInfo) => {
    const room = `sdb-${testInfo.testId}-${Date.now()}`;
    const streamId = 'pages-1';
    await goConnect(page, { room: room, streamId: streamId });

    await page.getByTestId('start-paginate').click();

    await expect
      .poll(async () => Number(await page.getByTestId('paginate-row-count').textContent()))
      .toBeGreaterThanOrEqual(3);
    const seenBeforeDrop = Number(await page.getByTestId('paginate-row-count').textContent());
    expect(seenBeforeDrop).toBeLessThan(10);

    await page.getByTestId('drop-socket').click();
    await expect(page.getByTestId('status')).toHaveText('disconnected');

    await page.getByTestId('since').fill(String(seenBeforeDrop));
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
    await page.getByTestId('send-resume').click();

    await expect.poll(() => page.getByTestId('paginate-row-count').textContent()).toBe('10');
    await expect.poll(() => page.getByTestId('stream-end-count').textContent()).toBe('1');

    const order = (await page.getByTestId('paginate-rows').textContent())!.split(',').map(Number);
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('resumable bare yield (no withCursor): resume restarts from a null cursor', async ({
    page,
  }, testInfo) => {
    const room = `sdb-${testInfo.testId}-${Date.now()}`;
    const streamId = 'bare-1';
    await goConnect(page, { room: room, streamId: streamId });

    await page.getByTestId('start-paginate-bare').click();
    await expect
      .poll(async () => Number(await page.getByTestId('paginate-bare-row-count').textContent()))
      .toBeGreaterThanOrEqual(1);
    const seenBeforeDrop = Number(await page.getByTestId('paginate-bare-row-count').textContent());
    expect(seenBeforeDrop).toBeLessThan(4);

    await page.getByTestId('drop-socket').click();
    await expect(page.getByTestId('status')).toHaveText('disconnected');

    await page.getByTestId('since').fill(String(seenBeforeDrop));
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
    await page.getByTestId('send-resume').click();

    await expect.poll(() => page.getByTestId('stream-end-count').textContent()).toBe('1');

    const rows = (await page.getByTestId('paginate-bare-rows').textContent())!
      .split(',')
      .map(Number);
    expect(Math.max(...rows)).toBeLessThan(100);
    expect(rows.slice(-4)).toEqual([1, 2, 3, 4]);
  });

  test('resume of an unknown stream id surfaces stream-aborted not-found', async ({
    page,
  }, testInfo) => {
    const room = `sdb-${testInfo.testId}-${Date.now()}`;
    await goConnect(page, { room: room, streamId: 'does-not-exist' });

    await page.getByTestId('send-resume').click();

    await expect
      .poll(() => page.getByTestId('last-error-code').textContent())
      .toBe('stream-aborted');
    await expect.poll(() => page.getByTestId('last-error-reason').textContent()).toBe('not-found');
    await expect
      .poll(() => page.getByTestId('last-error-stream-id').textContent())
      .toBe('does-not-exist');
  });

  test('ctx.stream.attempt — 1 on first run, 2 after resume', async ({ page }, testInfo) => {
    const room = `sdb-${testInfo.testId}-${Date.now()}`;
    const streamId = 'attempt-1';
    await goConnect(page, { room: room, streamId: streamId });

    await page.getByTestId('start-attempt').click();
    await expect.poll(() => page.getByTestId('attempt-value').textContent()).toBe('1');

    // Generator is parked in an await on the server. Drop the socket so the
    // stream goes `suspended`, then reconnect and resume — attempt becomes 2.
    await page.getByTestId('drop-socket').click();
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
    await page.getByTestId('send-resume').click();

    await expect.poll(() => page.getByTestId('attempt-value').textContent()).toBe('2');
  });

  test('buffer-full path — handler catches StreamAborted and the stream ends cleanly', async ({
    page,
  }, testInfo) => {
    const room = `sdb-${testInfo.testId}-${Date.now()}`;
    const streamId = 'bf-1';
    await goConnect(page, { room: room, streamId: streamId });

    await page.getByTestId('start-buffer-full').click();

    // Cap is maxChunks=2; the handler catches buffer-full and returns. The
    // page receives _streamEnd, no _error frame.
    await expect.poll(() => page.getByTestId('stream-end-count').textContent()).toBe('1');
    await expect.poll(() => page.getByTestId('last-error-code').textContent()).toBe('');
  });

  test('stream-id collision from a storage race surfaces one stream-id-collision _error', async ({
    browser,
  }, testInfo) => {
    const room = `sdb-${testInfo.testId}-${Date.now()}`;
    const streamId = 'race-1';

    // Both contexts use the SAME username, so they share identity and both
    // land on the same durable-object room. Fire 'count-tokens' with the
    // same _streamId from each socket as close together as possible. One
    // succeeds; the other gets a stream-id-collision _error.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    try {
      await pageA.goto(`/stream-durable?room=${room}`);
      await pageA.getByTestId('username').fill('race-user');
      await pageA.getByTestId('stream-id').fill(streamId);
      await pageA.getByTestId('connect').click();
      await expect(pageA.getByTestId('status')).toHaveText('connected');

      await pageB.goto(`/stream-durable?room=${room}`);
      await pageB.getByTestId('username').fill('race-user');
      await pageB.getByTestId('stream-id').fill(streamId);
      await pageB.getByTestId('connect').click();
      await expect(pageB.getByTestId('status')).toHaveText('connected');

      // Fire both in the same JS turn from the same Node process to maximise
      // the chance the second one hits the storage race in the DO.
      await Promise.all([
        pageA.getByTestId('start-count-tokens').click(),
        pageB.getByTestId('start-count-tokens').click(),
      ]);

      // Poll for resolution: one of the two pages must see a
      // stream-id-collision error.
      await expect
        .poll(
          async () => {
            const codeA = await pageA.getByTestId('last-error-code').textContent();
            const codeB = await pageB.getByTestId('last-error-code').textContent();
            return [codeA, codeB].includes('stream-id-collision') ? 'ok' : 'no';
          },
          { timeout: 10_000 },
        )
        .toBe('ok');

      // The other page must receive chunks (or be in the middle of receiving).
      await expect
        .poll(async () => {
          const a = Number(await pageA.getByTestId('token-chunk-count').textContent());
          const b = Number(await pageB.getByTestId('token-chunk-count').textContent());
          return Math.max(a, b);
        })
        .toBeGreaterThan(0);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('cancel deletes the durable row — subsequent resume returns not-found', async ({
    page,
  }, testInfo) => {
    const room = `sdb-${testInfo.testId}-${Date.now()}`;
    const streamId = 'cancel-1';
    await goConnect(page, { room: room, streamId: streamId });

    await page.getByTestId('start-paginate').click();
    await expect
      .poll(async () => Number(await page.getByTestId('paginate-row-count').textContent()))
      .toBeGreaterThanOrEqual(2);

    await page.getByTestId('send-cancel').click();

    // Give the server a beat to process cancel + delete the row.
    await page.waitForTimeout(800);
    await page.getByTestId('send-resume').click();

    await expect
      .poll(() => page.getByTestId('last-error-code').textContent())
      .toBe('stream-aborted');
    await expect.poll(() => page.getByTestId('last-error-reason').textContent()).toBe('not-found');
  });
});
