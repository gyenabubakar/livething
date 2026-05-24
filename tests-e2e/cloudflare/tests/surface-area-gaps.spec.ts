import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

async function openRig(page: Page, route: string) {
  await page.goto(route);
  await installRig(page);
}

test.describe('surface-area gaps', () => {
  test('request() inside a namespace returns the namespace-scoped response', async ({
    page,
  }, testInfo) => {
    const room = `sag-${testInfo.testId}`;
    await openRig(page, '/namespace');
    const a = await connect(page, { path: '/ws/namespace', username: 'alice', room: room });

    await send(page, a, {
      event: 'get-ns-info',
      payload: {},
      __wskit: { namespace: 'ns', correlationId: 'corr-1' },
    });

    const reply = await waitForFrame(page, a, {
      match: (f) => f.event === 'get-ns-info' && f.__wskit?.correlationId === 'corr-1',
    });
    expect(reply.__wskit?.namespace).toBe('ns');
    expect(reply.payload.namespace).toBe('ns');
  });

  test('rateLimit cascade — contract → namespace → channel → per-handler override all observable in one contract', async ({
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
    await page.waitForTimeout(150);
    const topErrors = (await frames(page, a)).filter(
      (f) => f.event === '__error__' && f.payload.code === 'rate-limited',
    );
    expect(topErrors.length).toBeGreaterThanOrEqual(1);

    // Layer 2 — namespace cap (strict namespace max=2, tighter than contract).
    // The namespace bucket is independent of the top-level bucket.
    for (let i = 0; i < 2; i += 1) {
      await send(page, a, { event: 'strict-ping', payload: {}, __wskit: { namespace: 'strict' } });
    }
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'strict-pong' && f.__wskit?.namespace === 'strict',
        ).length >= 2,
      [a],
    );
    await send(page, a, { event: 'strict-ping', payload: {}, __wskit: { namespace: 'strict' } });
    await page.waitForTimeout(150);
    const allErrors = (await frames(page, a)).filter(
      (f) => f.event === '__error__' && f.payload.code === 'rate-limited',
    );
    expect(allErrors.length).toBeGreaterThanOrEqual(2);

    // Layer 3 — channel cap (rooms channel max=50, looser than contract).
    // No errors when sending one chatter — it would have been rate-limited at
    // the contract level had the channel not raised the cap. But the channel
    // also has a per-handler override on 'chatter' (max=1), so a second
    // 'chatter' is rejected at layer 4.
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

    // Layer 4 — per-handler override (chatter max=1) — second chatter rejected.
    await send(page, a, {
      event: 'chatter',
      payload: { text: 'hi2' },
      __wskit: { channel: 'rooms' },
    });
    await page.waitForTimeout(150);
    const chatErrors = (await frames(page, a)).filter(
      (f) => f.event === '__error__' && f.payload.code === 'rate-limited',
    );
    expect(chatErrors.length).toBeGreaterThanOrEqual(3);
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

  test('intercept on a sub-builder rewrites the payload of a stream trigger', async ({
    page,
  }, testInfo) => {
    const room = `sag-${testInfo.testId}`;
    await page.goto('/intercept');
    await installRig(page);
    const a = await connect(page, { path: '/ws/intercept', username: 'alice', room: room });

    await send(page, a, {
      event: 'intercepted-stream',
      payload: { text: 'hello' },
      __wskit: { namespace: 'ns' },
    });
    const ok = await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    const streamId = ok.__wskit?.streamId as string;

    const chunk = await waitForFrame(page, a, {
      match: (f) =>
        f.event === 'intercepted-stream' &&
        f.__wskit?.streamId === streamId &&
        typeof f.payload?.text === 'string',
    });
    // The namespace's intercept appends `-rewritten` to payload.text via
    // matches() narrowing before the generator receives it.
    expect(chunk.payload.text).toBe('hello-rewritten');
  });
});
