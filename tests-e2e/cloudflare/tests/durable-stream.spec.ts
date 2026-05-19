import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function goConnect(page: Page, room: string, streamId: string, username = 'ds-user') {
  await page.goto(`/durable-stream?room=${room}`);
  await page.getByTestId('username').fill(username);
  await page.getByTestId('stream-id').fill(streamId);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('connected');
}

test.describe('durable-stream', () => {
  test('recorded stream: chunks buffered in storage replay on resume', async ({
    page,
  }, testInfo) => {
    const room = `dst-${testInfo.testId}`;
    const streamId = 'conv-1';
    await goConnect(page, room, streamId);

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
    const room = `dst-${testInfo.testId}`;
    const streamId = 'pages-1';
    await goConnect(page, room, streamId);

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

  test('resume of an unknown stream id surfaces stream-aborted not-found', async ({
    page,
  }, testInfo) => {
    const room = `dst-${testInfo.testId}`;
    await goConnect(page, room, 'does-not-exist');

    await page.getByTestId('send-resume').click();

    await expect
      .poll(() => page.getByTestId('last-error-code').textContent())
      .toBe('stream-aborted');
    await expect.poll(() => page.getByTestId('last-error-reason').textContent()).toBe('not-found');
    await expect
      .poll(() => page.getByTestId('last-error-stream-id').textContent())
      .toBe('does-not-exist');
  });
});
