import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout: 10_000 });
}

test.describe('custom replay handler', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/replay-custom?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('sends and receives notes', async ({ page }) => {
    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /testuser: custom replay note/);
  });

  test('custom replay returns stored notes', async ({ page }) => {
    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /custom replay note/);

    const beforeCount = (await page.getByTestId('notes').textContent())!.split(' | ').length;
    await page.getByTestId('replay-btn').click();
    await expect(async () => {
      const afterCount = (await page.getByTestId('notes').textContent())!.split(' | ').length;
      expect(afterCount).toBeGreaterThan(beforeCount);
    }).toPass({ timeout: 5_000 });
  });

  test('channel-scoped custom replay returns channel messages', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');

    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /custom replay note/);

    await page.getByTestId('room-note-btn').click();
    await waitForText(page, 'room-notes', /channel replay note/);

    await page.getByTestId('room-replay-btn').click();
    await expect(async () => {
      const roomReplayCount = Number(await page.getByTestId('room-replay-count').textContent());
      expect(roomReplayCount).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });
  });

  test('channel __replay__ request hits the channel handler, not the server-level handler', async ({
    page,
  }) => {
    // The channel claim must win over the server-level replay handler, so
    // channel-scoped requests do not receive top-level rows.

    // Add a top-level note. Stored in `_custom_replay`.
    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /custom replay note/);

    // Join the channel and add a channel note. Stored in `_custom_room_replay`.
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');
    await page.getByTestId('room-note-btn').click();
    await waitForText(page, 'room-notes', /channel replay note/);

    // Trigger a channel-scoped __replay__. Only the channel handler should run.
    await page.getByTestId('room-replay-btn').click();

    // Channel rows arrived (channel handler did fire).
    await expect(async () => {
      const count = Number(await page.getByTestId('room-replay-count').textContent());
      expect(count).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });

    // Server-level handler MUST be skipped — its rows would land in the
    // top-level `notes` bucket and increment replayCount. Wait long enough
    // for any rogue rows to have arrived, then assert it stayed at 0.
    await page.waitForTimeout(1000);
    expect(await page.getByTestId('replay-count').textContent()).toBe('0');
  });

  test('afterBroadcast marks messages as confirmed', async ({ page }) => {
    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /custom replay note/);

    await page.getByTestId('confirmed-btn').click();
    await waitForText(page, 'confirmed-result', /total:\d+,confirmed:\d+/);

    const result = await page.getByTestId('confirmed-result').textContent();
    const match = result!.match(/total:(\d+),confirmed:(\d+)/);
    expect(Number(match![1])).toBeGreaterThan(0);
    expect(Number(match![2])).toBeGreaterThan(0);
  });

  test('channel afterBroadcast marks room messages as confirmed', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');

    await page.getByTestId('room-note-btn').click();
    await waitForText(page, 'room-notes', /channel replay note/);

    await page.getByTestId('room-confirmed-btn').click();
    await waitForText(page, 'room-confirmed-result', /total:\d+,confirmed:\d+/);

    const result = await page.getByTestId('room-confirmed-result').textContent();
    const match = result!.match(/total:(\d+),confirmed:(\d+)/);
    expect(Number(match![1])).toBeGreaterThan(0);
    expect(Number(match![2])).toBeGreaterThan(0);
  });

  test('custom replay supports nonzero since', async ({ page }) => {
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(window.__livethingEncode({ event: 'add-note', payload: { text: 'top-old' } }));
    });
    await waitForText(page, 'notes', /top-old/);
    const since = Number(await page.getByTestId('last-seq').textContent());

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(window.__livethingEncode({ event: 'add-note', payload: { text: 'top-new' } }));
    });
    await waitForText(page, 'notes', /top-new/);

    await page.reload();
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('since-input').fill(String(since));

    await page.getByTestId('replay-btn').click();

    await expect(async () => {
      const notes = await page.getByTestId('notes').textContent();
      expect(notes).toContain('top-new');
      expect(notes).not.toContain('top-old');
    }).toPass({ timeout: 5_000 });
  });

  test('channel custom replay supports nonzero since', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        window.__livethingEncode({
          event: 'add-room-note',
          payload: { text: 'room-old' },
          metadata: { channel: { name: 'custom-room' } },
        }),
      );
    });
    await waitForText(page, 'room-notes', /room-old/);
    const since = Number(await page.getByTestId('last-seq').textContent());

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        window.__livethingEncode({
          event: 'add-room-note',
          payload: { text: 'room-new' },
          metadata: { channel: { name: 'custom-room' } },
        }),
      );
    });
    await waitForText(page, 'room-notes', /room-new/);

    await page.reload();
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('room-join-btn').click();

    await waitForText(page, 'room-subscribed', 'subscribed');
    await page.getByTestId('room-since-input').fill(String(since));
    await page.getByTestId('room-replay-btn').click();

    await expect(async () => {
      const notes = await page.getByTestId('room-notes').textContent();
      expect(notes).toContain('room-new');
      expect(notes).not.toContain('room-old');
    }).toPass({ timeout: 5_000 });
  });

  test('custom replay ctx.sendReplay rejects an undeclared event', async ({ page }) => {
    // Custom replay's onReplay ctx.sendReplay runs the same declaration check
    // as the built-in replay path — an undeclared event is rejected.
    await page.getByTestId('trigger-bad-replay-btn').click();
    // Settle the __replay__ round-trip before querying the log.
    await page.waitForTimeout(200);
    await page.getByTestId('query-bad-replay-btn').click();
    await expect(page.getByTestId('bad-replay-undeclared')).toContainText(
      'not declared in the active scope',
    );
    // Sanity: the rejected send did not break the connection.
    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /custom replay note/);
  });
});
