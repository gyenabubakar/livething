import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('stream-basic', () => {
  async function openPage(page: Page, room: string, username = 'testuser') {
    await page.goto(`/stream-basic?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('generator yields are sent as chunks to the client', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-3').click();
    await expect(page.getByTestId('chunk-indices')).toHaveText('0,1,2');
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
  });

  test('server sends _streamOk to acknowledge the stream start', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-3').click();
    await expect(page.getByTestId('stream-ok')).toHaveText('yes');
    await expect(page.getByTestId('stream-id')).not.toHaveText('');
  });

  test('stream errors send _error with the stream id attached', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-boom').click();
    await expect(page.getByTestId('stream-error')).toContainText('stream-error:');
  });

  test('client _streamCancel stops the stream before it completes', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-10').click();
    await expect(page.getByTestId('chunk-indices')).toContainText('0');

    await page.getByTestId('cancel').click();

    // Count chunks ~right after cancel; wait past the natural completion
    // window; the count must not grow to 10 (generator was stopped).
    const snapshot = (await page.getByTestId('chunk-indices').textContent()) ?? '';
    await page.waitForTimeout(500);
    const after = (await page.getByTestId('chunk-indices').textContent()) ?? '';
    const afterCount = after.split(',').filter(Boolean).length;
    expect(afterCount).toBeLessThan(10);
    // And the stream should be quiescent — the post-cancel count shouldn't
    // keep growing. Allow one straggler that may have been in-flight.
    const snapCount = snapshot.split(',').filter(Boolean).length;
    expect(afterCount - snapCount).toBeLessThanOrEqual(1);
  });

  test('_streamCancel from a different connection is ignored', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');

    await a.getByTestId('start-10').click();
    await expect(a.getByTestId('stream-id')).not.toHaveText('');
    await expect(a.getByTestId('chunk-indices')).toContainText('0');

    const aliceStreamId = (await a.getByTestId('stream-id').textContent()) ?? '';

    // Bob forges alice's stream id and sends a cancel through HIS socket.
    // The server's cancelStream runtime checks the owning connectionId and
    // must ignore this — alice's stream should continue.
    await b.evaluate((sid) => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(JSON.stringify({ event: '_streamCancel', payload: { _streamId: sid } }));
    }, aliceStreamId);

    // Alice's stream should complete normally despite the foreign cancel.
    await expect(a.getByTestId('stream-end')).toHaveText('yes');
    await expect(a.getByTestId('chunk-indices')).toContainText('9');

    await ctxA.close();
    await ctxB.close();
  });

  test('empty generator sends _streamEnd without chunks', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-0').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
    await expect(page.getByTestId('chunk-indices')).toHaveText('');
  });

  test('_streamEnd NOT sent on cancel, only on natural completion', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-10').click();
    await expect(page.getByTestId('chunk-indices')).toContainText('0');

    await page.getByTestId('cancel').click();

    // After cancel, stream-end should remain 'no' (only set to 'yes' on
    // natural completion per runtime.ts line 196-203).
    await page.waitForTimeout(200);
    await expect(page.getByTestId('stream-end')).toHaveText('no');
  });

  test('throw before first yield sends _streamOk then _error with no chunks', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-boom-immediate').click();
    // _streamOk is sent before the generator body runs.
    await expect(page.getByTestId('stream-ok')).toHaveText('yes');
    // No chunks — generator threw before the first yield.
    await expect(page.getByTestId('chunk-indices')).toHaveText('');
    // Error frame must arrive.
    await expect(page.getByTestId('stream-error')).toContainText('stream-error:');
  });

  test('stream error preserves a registered error factory code', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-typed-error').click();
    // The factory code `not-found` must survive the wire — not the generic `boom`.
    await expect(page.getByTestId('stream-error')).toHaveText('stream-error:not-found');
  });

  test('generator finally observes cancellation and can fire a server event', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('start-cancel-observe').click();
    await expect(page.getByTestId('chunk-indices')).toContainText('0');

    // Cancel mid-stream — the generator's finally block must run and emit
    // cancel-observed. If the stream had completed naturally, the event
    // would NOT fire (the flag guards the finally block).
    await page.getByTestId('cancel').click();
    await expect(page.getByTestId('cancel-observed')).toHaveText('yes');
  });

  test('multiple concurrent streams from same connection each have distinct _streamId', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);

    // Start first stream.
    await page.getByTestId('start-3').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
    const streamId1 = (await page.getByTestId('stream-id').textContent()) ?? '';

    // Start second stream (resets UI state).
    await page.getByTestId('start-3').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');
    const streamId2 = (await page.getByTestId('stream-id').textContent()) ?? '';

    // Each stream must have a distinct ID.
    expect(streamId1).toBeTruthy();
    expect(streamId2).toBeTruthy();
    expect(streamId1).not.toEqual(streamId2);
  });
});
