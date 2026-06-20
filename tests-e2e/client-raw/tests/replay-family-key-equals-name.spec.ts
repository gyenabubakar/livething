import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type Frame = {
  event: string;
  payload: Record<string, unknown>;
  __wskit?: Record<string, unknown>;
};

async function setupClient(page: Page, username: string, room: string) {
  await page.goto(`/replay-family-key-equals-name?room=${room}`);
  await page.getByTestId('username').fill(username);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('connected');
}

async function startCapture(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __ws?: WebSocket; __frames?: Frame[] };
    w.__frames = [];
    const ws = w.__ws!;
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      w.__frames!.push(JSON.parse(ev.data));
    });
  });
}

async function send(page: Page, frame: unknown) {
  await page.evaluate((f) => {
    const ws = (window as unknown as { __ws?: WebSocket }).__ws;
    ws?.send(JSON.stringify(f));
  }, frame);
}

async function frames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __frames?: Frame[] };
    return (w.__frames ?? []).slice();
  });
}

async function disconnectAndReload(page: Page, room: string) {
  await page.evaluate(() => {
    const w = window as unknown as { __ws?: WebSocket };
    w.__ws?.close();
  });
  await page.goto(`/replay-family-key-equals-name?room=${room}`);
  await expect(page.getByTestId('status')).toHaveText('disconnected');
}

async function reconnect(page: Page, username: string) {
  await page.getByTestId('username').fill(username);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('connected');
}

test.describe('replay-family-key-equals-name', () => {
  test('a family whose pattern matches its own key replays the full history after reconnect', async ({
    page,
  }, testInfo) => {
    const room = `rfken-${testInfo.testId}-${Date.now()}-${testInfo.retry}`;
    await setupClient(page, 'alice', room);
    await startCapture(page);

    // Subscribe to family member 'rooms' (the only name the pattern accepts).
    await send(page, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'rooms', channelFamily: 'rooms' },
    });
    await expect
      .poll(async () => (await frames(page)).some((f) => f.event === '__subscribeOk__'), {
        timeout: 5_000,
      })
      .toBe(true);

    // Broadcast 3 messages.
    await send(page, {
      event: 'send-batch',
      payload: { count: 3 },
      __wskit: { channel: 'rooms', channelFamily: 'rooms' },
    });
    await expect
      .poll(
        async () =>
          (await frames(page)).filter(
            (f) => f.event === 'room-message' && f.__wskit?.channel === 'rooms',
          ).length,
        { timeout: 5_000 },
      )
      .toBe(3);

    const liveRoomMsgs = (await frames(page)).filter(
      (f) => f.event === 'room-message' && f.__wskit?.channel === 'rooms',
    );
    const liveSeqs = liveRoomMsgs.map((f) => f.__wskit?.seq as number);
    expect(liveSeqs.length).toBe(3);
    expect(liveSeqs.every((s) => typeof s === 'number' && s > 0)).toBe(true);
    const lastSeq = Math.max(...liveSeqs);

    // Disconnect cleanly and reload to reset page state.
    await disconnectAndReload(page, room);

    // Reopen a fresh socket.
    await reconnect(page, 'alice');
    await startCapture(page);

    // Re-subscribe.
    await send(page, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'rooms', channelFamily: 'rooms' },
    });
    await expect
      .poll(async () => (await frames(page)).some((f) => f.event === '__subscribeOk__'), {
        timeout: 5_000,
      })
      .toBe(true);

    // Replay since 0 — under the prior heuristic this returned nothing
    // because the family key equals the concrete subscribed name. The fix
    // queries the family rows and returns all 3.
    await send(page, {
      event: '__replay__',
      payload: { lastKnownSeq: 0 },
      __wskit: { channel: 'rooms', channelFamily: 'rooms' },
    });
    await expect
      .poll(
        async () =>
          (await frames(page)).filter(
            (f) =>
              f.event === 'room-message' &&
              f.__wskit?.channel === 'rooms' &&
              f.__wskit?.channelFamily === 'rooms',
          ).length,
        { timeout: 5_000 },
      )
      .toBe(3);

    const replayed = (await frames(page)).filter(
      (f) =>
        f.event === 'room-message' &&
        f.__wskit?.channel === 'rooms' &&
        f.__wskit?.channelFamily === 'rooms',
    );
    expect(replayed.map((f) => f.payload.text).sort()).toEqual(['msg-0', 'msg-1', 'msg-2']);
    expect(replayed.map((f) => f.__wskit?.seq as number).sort((a, b) => a - b)).toEqual(
      liveSeqs.slice().sort((a, b) => a - b),
    );

    // Negative case: replay since the latest seq returns no rows.
    await send(page, {
      event: '__replay__',
      payload: { lastKnownSeq: lastSeq },
      __wskit: { channel: 'rooms', channelFamily: 'rooms' },
    });
    await page.waitForTimeout(500);
    const after = (await frames(page)).filter(
      (f) =>
        f.event === 'room-message' &&
        f.__wskit?.channel === 'rooms' &&
        f.__wskit?.channelFamily === 'rooms',
    );
    // Still exactly the 3 from the previous since:0 replay — no new rows.
    expect(after.length).toBe(3);
  });
});
