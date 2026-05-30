import { expect, test } from '@playwright/test';
import { connect, installRig, send, waitForFrame } from './_ws-rig.ts';

test.describe('dedup', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/dedup?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('outgoing messages have unique messageId', async ({ page }) => {
    await page.getByTestId('echo-plain').click();
    await expect(page.getByTestId('count-plain')).toHaveText('1');
    await page.getByTestId('echo-plain').click();
    await expect(page.getByTestId('count-plain')).toHaveText('2');

    const ids = (await page.getByTestId('outgoing-ids').textContent()) ?? '';
    const idList = ids.split(',').filter(Boolean);
    expect(idList.length).toBeGreaterThanOrEqual(2);
    expect(new Set(idList).size).toBe(idList.length);
  });

  test('incoming frames with a repeated messageId run the handler once', async ({ page }) => {
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

  test('incoming frames without a messageId are always dispatched', async ({ page }) => {
    await page.getByTestId('echo-no-id').click();
    await expect(page.getByTestId('count-no-id')).toHaveText('1');

    // No messageId — at-least-once semantics, handler runs again.
    await page.getByTestId('echo-no-id').click();
    await expect(page.getByTestId('count-no-id')).toHaveText('2');
  });

  test('protocol frames (__subscribe__) are not deduplicated', async ({ page }) => {
    // Gateway dedup only runs on user-event frames; protocol frames bypass it.
    // Two identical __subscribe__ frames must each get their own __subscribeOk__.
    const subscribeOkCount = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');
      let acks = 0;
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          const frame = JSON.parse(ev.data);
          if (frame.event === '__subscribeOk__' && frame.__wskit?.channel === 'room') acks += 1;
        }
        if (typeof original === 'function') original.call(ws, ev);
      };
      const frame = {
        event: '__subscribe__',
        payload: {},
        __wskit: { channel: 'room' },
      };
      ws.send(JSON.stringify(frame));
      ws.send(JSON.stringify(frame));
      await new Promise((r) => setTimeout(r, 400));
      ws.onmessage = original;
      return acks;
    });

    expect(subscribeOkCount).toBe(2);
  });

  test('incoming messageId dedup drops a resent frame on a connection', async ({ page }) => {
    // The same messageId resent on one connection is dropped before the handler
    // runs. (Whether the cache is shared ACROSS event types is a separate gap:
    // this handler declares only one incoming event, so it cannot prove that.)

    // Send first do-echo with a fixed messageId.
    await page.getByTestId('echo-dup-id').click();
    await expect(page.getByTestId('count-dup-hi')).toHaveText('1');

    // Resend the identical frame (same messageId): it is dropped. The fresh
    // echo-plain frame is the positive signal that the connection is alive and
    // still processing, so the unchanged count proves dedup — not a dead link.
    await page.getByTestId('echo-dup-id').click();
    await page.getByTestId('echo-plain').click();
    await expect(page.getByTestId('count-plain')).toHaveText('1');
    await expect(page.getByTestId('count-dup-hi')).toHaveText('1');
  });

  test('dedup is per-connection — the same messageId on two connections both dispatch', async ({
    page,
  }, testInfo) => {
    // The dedup cache is scoped to a connection, so an identical messageId on a
    // different connection is NOT treated as a duplicate — both handlers run.
    await installRig(page);
    const room = `dedup-iso-${testInfo.testId}`;
    const a = await connect(page, { path: '/ws/dedup', username: 'alice', room });
    const b = await connect(page, { path: '/ws/dedup', username: 'bob', room });

    const sharedMsgId = 'shared-cross-conn-id';
    await send(page, a, {
      event: 'do-echo',
      payload: { text: 'from-alice' },
      __wskit: { messageId: sharedMsgId },
    });
    await send(page, b, {
      event: 'do-echo',
      payload: { text: 'from-bob' },
      __wskit: { messageId: sharedMsgId },
    });

    await waitForFrame(page, a, {
      match: (f) => f.event === 'echoed' && f.payload.text === 'from-alice',
    });
    await waitForFrame(page, b, {
      match: (f) => f.event === 'echoed' && f.payload.text === 'from-bob',
    });
  });
});
