import { expect, test } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

test.describe('surface-area gaps', () => {
  test('rateLimit cascade — contract → channel → per-handler override all observable in one contract', async ({
    page,
  }, testInfo) => {
    const room = `sag-${testInfo.testId}`;
    await page.goto('/rate-limit');
    await installRig(page);
    const a = await connect(page, { path: '/ws/rate-limit', username: 'alice', room: room });

    // Layer 1 — contract cap (top-level max=3). Fourth 'tick' rejected.
    for (let i = 0; i < 3; i += 1) {
      await send(page, a, { event: 'tick', payload: {} });
    }
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter((f) => f.event === 'tock').length >= 3,
      [a],
    );
    await send(page, a, { event: 'tick', payload: {} });
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === '__error__' && f.payload?.code === 'rate-limited',
        ).length >= 1,
      [a],
    );
    const topErrors = (await frames(page, a)).filter(
      (f) => f.event === '__error__' && f.payload.code === 'rate-limited',
    );
    expect(topErrors.length).toBeGreaterThanOrEqual(1);

    // Layer 2 — channel cap (rooms channel max=50, looser than contract).
    // No errors when sending one chatter — it would have been rate-limited at
    // the contract level had the channel not raised the cap. But the channel
    // also has a per-handler override on 'chatter' (max=1), so a second
    // 'chatter' is rejected at layer 3.
    await send(page, a, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'rooms' },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });
    await send(page, a, {
      event: 'chatter',
      payload: { text: 'hi' },
      __wskit: { channel: 'rooms' },
    });
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'chatter-broadcast' && f.__wskit?.channel === 'rooms',
        ).length >= 1,
      [a],
    );

    // Layer 3 — per-handler override (chatter max=1) — second chatter rejected.
    await send(page, a, {
      event: 'chatter',
      payload: { text: 'hi2' },
      __wskit: { channel: 'rooms' },
    });
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === '__error__' && f.payload?.code === 'rate-limited',
        ).length >= 2,
      [a],
    );
    const chatErrors = (await frames(page, a)).filter(
      (f) => f.event === '__error__' && f.payload.code === 'rate-limited',
    );
    expect(chatErrors.length).toBeGreaterThanOrEqual(2);
  });

  test('customReplay on a channel that has a stream — stream chunks never enter the replay log', async ({
    page,
  }, testInfo) => {
    const room = `sag-${testInfo.testId}`;
    await page.goto('/replay-custom');
    await installRig(page);
    const a = await connect(page, { path: '/ws/replay-custom', username: 'alice', room: room });

    await send(page, a, {
      event: '__subscribe__',
      payload: {},
      __wskit: { channel: 'custom-room' },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    // Trigger one logged outgoing (room-note via add-room-note) so the
    // replay log has at least one row to look at.
    await send(page, a, {
      event: 'add-room-note',
      payload: { text: 'before-stream' },
      __wskit: { channel: 'custom-room' },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === 'room-note' && f.__wskit?.channel === 'custom-room',
    });

    // Trigger the channel-scoped stream — it emits chunks via the outgoing
    // pipeline but those chunks must NOT show up in the customReplay log
    // (replay is for `outgoing(...)` only).
    await send(page, a, {
      event: 'room-stream',
      payload: { count: 3 },
      __wskit: { channel: 'custom-room' },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__streamEnd__' });

    await send(page, a, {
      event: 'query-room-replay-events',
      payload: {},
      __wskit: { channel: 'custom-room' },
    });
    const logged = await waitForFrame(page, a, {
      match: (f) => f.event === 'room-replay-events' && f.__wskit?.channel === 'custom-room',
    });
    const events = logged.payload.events as string[];
    expect(events).toContain('room-note');
    expect(events).not.toContain('room-stream');
  });
});
