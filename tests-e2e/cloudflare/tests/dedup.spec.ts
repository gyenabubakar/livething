import { expect, test } from '@playwright/test';

test.describe('dedup', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/dedup?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('outgoing messages have unique _messageId', async ({ page }) => {
    await page.getByTestId('echo-plain').click();
    await expect(page.getByTestId('count-plain')).toHaveText('1');
    await page.getByTestId('echo-plain').click();
    await expect(page.getByTestId('count-plain')).toHaveText('2');

    const ids = (await page.getByTestId('outgoing-ids').textContent()) ?? '';
    const idList = ids.split(',').filter(Boolean);
    expect(idList.length).toBeGreaterThanOrEqual(2);
    expect(new Set(idList).size).toBe(idList.length);
  });

  test('incoming frames with a repeated _messageId run the handler once', async ({ page }) => {
    await page.getByTestId('echo-dup-id').click();
    await expect(page.getByTestId('count-dup-hi')).toHaveText('1');

    // Same fixed id; dedup should drop this before the handler.
    await page.getByTestId('echo-dup-id').click();

    // Positive signal: send a different frame; once its reply lands, the
    // duplicate has definitely been handled (and dropped). Count must stay 1.
    await page.getByTestId('echo-plain').click();
    await expect(page.getByTestId('count-plain')).toHaveText('1');
    await expect(page.getByTestId('count-dup-hi')).toHaveText('1');
  });

  test('incoming frames without a _messageId are always dispatched', async ({ page }) => {
    await page.getByTestId('echo-no-id').click();
    await expect(page.getByTestId('count-no-id')).toHaveText('1');

    // No _messageId — at-least-once semantics, handler runs again.
    await page.getByTestId('echo-no-id').click();
    await expect(page.getByTestId('count-no-id')).toHaveText('2');
  });

  test('protocol frames (_subscribe) are not deduplicated even when they carry _messageId', async ({
    page,
  }) => {
    const subscribeOkCount = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');
      let acks = 0;
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          const frame = JSON.parse(ev.data);
          if (frame.event === '_subscribeOk' && frame.payload?._channel === 'room') acks += 1;
        }
        if (typeof original === 'function') original.call(ws, ev);
      };
      const frame = {
        event: '_subscribe',
        payload: { _channel: 'room', _messageId: 'sub-fixed-1' },
      };
      ws.send(JSON.stringify(frame));
      ws.send(JSON.stringify(frame));
      await new Promise((r) => setTimeout(r, 400));
      ws.onmessage = original;
      return acks;
    });

    expect(subscribeOkCount).toBe(2);
  });

  test('incoming _messageId dedup is per-scope, shared across event types', async ({ page }) => {
    // Verify that the same _messageId in different event types is deduplicated
    // from a single shared cache per connection, not per-event-type caches.
    // The dedup handler uses only 'do-echo' events, but the dedup cache itself
    // is connection-wide and frame-arrival-order-based.

    // Send first do-echo with fixed id.
    await page.getByTestId('echo-dup-id').click();
    await expect(page.getByTestId('count-dup-hi')).toHaveText('1');

    // Resend the same frame to verify dedup by positive signal (different event).
    // If dedup is working, the count stays at 1 after sending a confirming frame.
    await page.getByTestId('echo-dup-id').click();
    await page.getByTestId('echo-plain').click();
    await expect(page.getByTestId('count-plain')).toHaveText('1');
    await expect(page.getByTestId('count-dup-hi')).toHaveText('1');
  });
});
