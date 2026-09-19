import { expect, test } from '@playwright/test';
import { connect, installRig, send, waitForFrame } from './_ws-rig.ts';

test.describe('dedup', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/dedup?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('outgoing messages have unique metadata.delivery.id values', async ({ page }) => {
    await page.getByTestId('echo-plain').click();
    await expect(page.getByTestId('count-plain')).toHaveText('1');
    await page.getByTestId('echo-plain').click();
    await expect(page.getByTestId('count-plain')).toHaveText('2');

    const ids = (await page.getByTestId('outgoing-ids').textContent()) ?? '';
    const idList = ids.split(',').filter(Boolean);
    expect(idList.length).toBeGreaterThanOrEqual(2);
    expect(new Set(idList).size).toBe(idList.length);
  });

  test('incoming frames with a repeated metadata.delivery.id run the handler once', async ({
    page,
  }) => {
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

  test('incoming frames without metadata.delivery.id are always dispatched', async ({ page }) => {
    await page.getByTestId('echo-no-id').click();
    await expect(page.getByTestId('count-no-id')).toHaveText('1');

    // No delivery ID means at-least-once delivery, so the handler runs again.
    await page.getByTestId('echo-no-id').click();
    await expect(page.getByTestId('count-no-id')).toHaveText('2');
  });

  test('a duplicate __subscribe__ is idempotent server-side (one ack)', async ({ page }) => {
    // Subscribe is idempotent by membership, not by the delivery-ID cache:
    // the first __subscribe__ joins and acks, the second sees an existing member
    // and answers nothing. Two identical frames must yield exactly one ack.
    const subscribeOkCount = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      let acks = 0;
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          const frame = window.__livethingDecode(ev.data);
          if (frame.event === '__subscribeOk__' && frame.metadata?.channel?.name === 'room')
            acks += 1;
        }

        if (typeof original === 'function') original.call(ws, ev);
      };

      const frame = {
        event: '__subscribe__',
        payload: null,
        metadata: { channel: { name: 'room' } },
      };

      ws.send(window.__livethingEncode(frame));
      ws.send(window.__livethingEncode(frame));
      await new Promise((r) => setTimeout(r, 400));
      ws.onmessage = original;

      return acks;
    });

    expect(subscribeOkCount).toBe(1);
  });

  test('incoming delivery-ID dedup drops a resent frame on a connection', async ({ page }) => {
    // The same `metadata.delivery.id` on one connection is dropped before the handler
    // runs. (Whether the cache is shared ACROSS event types is a separate gap:
    // this handler declares only one incoming event, so it cannot prove that.)

    // Send the first do-echo with a fixed delivery ID.
    await page.getByTestId('echo-dup-id').click();
    await expect(page.getByTestId('count-dup-hi')).toHaveText('1');

    // Resend the identical frame with the same delivery ID: it is dropped. The fresh
    // echo-plain frame is the positive signal that the connection is alive and
    // still processing, so the unchanged count proves dedup — not a dead link.
    await page.getByTestId('echo-dup-id').click();
    await page.getByTestId('echo-plain').click();
    await expect(page.getByTestId('count-plain')).toHaveText('1');
    await expect(page.getByTestId('count-dup-hi')).toHaveText('1');
  });

  test('dedup is per-connection — the same delivery ID on two connections dispatches twice', async ({
    page,
  }, testInfo) => {
    // The dedup cache is scoped to a connection, so an identical delivery ID on a
    // different connection is NOT treated as a duplicate — both handlers run.
    await installRig(page);
    const room = `dedup-iso-${testInfo.testId}`;
    const a = await connect(page, { path: '/ws/dedup', username: 'alice', room });
    const b = await connect(page, { path: '/ws/dedup', username: 'bob', room });

    const sharedMsgId = 'shared-cross-conn-id';
    await send(page, a, {
      event: 'do-echo',
      payload: { text: 'from-alice' },
      metadata: { delivery: { id: sharedMsgId } },
    });
    await send(page, b, {
      event: 'do-echo',
      payload: { text: 'from-bob' },
      metadata: { delivery: { id: sharedMsgId } },
    });

    await waitForFrame(page, a, {
      match: (f) => f.event === 'echoed' && f.payload.text === 'from-alice',
    });
    await waitForFrame(page, b, {
      match: (f) => f.event === 'echoed' && f.payload.text === 'from-bob',
    });
  });
});
