import { expect, test } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';
import type { WireFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-durable-scoped';

/**
 * A nudge for a channel-scoped stream must resolve to the stream's own scope
 * and the connection must still hold that membership. A nudge that omits the
 * channel markers, or arrives after the connection left the channel, is
 * rejected non-terminally and never reaches the generator.
 */
test.describe('stream nudge scope gate', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/stream-durable-scoped');
    await installRig(page);
  });

  test('a nudge that omits the channel scope markers is rejected and never reaches the stream', async ({
    page,
  }, testInfo) => {
    const room = `nsg-${testInfo.testId}-${Date.now()}`;
    const streamId = 'tokens-noscope-1';

    const a = await connect(page, { path: WS_PATH, username: 'alice', room });
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'channel-tokens',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.__wskit?.streamId === streamId,
    });

    // Wait for a couple of tokens so the stream is firmly running.
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'channel-tokens' && typeof f.payload?.token === 'string',
        ).length >= 2,
      [a],
    );

    // The stop nudge omits the channel markers — claimed top-level scope does
    // not match the stream's stored channel scope, so it must be rejected.
    await send(page, a, {
      event: 'stop',
      payload: {},
      __wskit: { streamId, streamNudgeId: 'noscope-stop' },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.__wskit?.streamNudgeId === 'noscope-stop',
    });
    expect(err.__wskit?.streamId).toBe(streamId);
    expect(err.__wskit?.streamTerminated).toBe(false);

    // The nudge never reached the generator, so the stream did NOT stop: it keeps
    // producing tokens past the point a delivered stop would have ended it.
    const before = (await frames(page, a)).filter(
      (f) => f.event === 'channel-tokens' && typeof f.payload?.token === 'string',
    ).length;
    await page.waitForFunction(
      ([sid, n]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'channel-tokens' && typeof f.payload?.token === 'string',
        ).length > (n as number),
      [a, before],
    );

    // A correctly-scoped stop then ends the stream — proving the gate, not a
    // broken nudge path, blocked the first attempt.
    await send(page, a, {
      event: 'stop',
      payload: {},
      __wskit: { channel: 'rooms', streamId, streamNudgeId: 'scoped-stop' },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    });
  });

  test('a nudge sent after leaving the channel is rejected and never reaches the stream', async ({
    page,
  }, testInfo) => {
    const room = `nsg-left-${testInfo.testId}-${Date.now()}`;
    const streamId = 'tokens-left-1';

    const a = await connect(page, { path: WS_PATH, username: 'alice', room });
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'channel-tokens',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.__wskit?.streamId === streamId,
    });

    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'channel-tokens' && typeof f.payload?.token === 'string',
        ).length >= 2,
      [a],
    );

    // Leave the channel, then nudge with the original channel markers. The
    // connection no longer holds the membership, so the nudge is rejected.
    await send(page, a, { event: '__unsubscribe__', payload: {}, __wskit: { channel: 'rooms' } });

    await send(page, a, {
      event: 'stop',
      payload: {},
      __wskit: { channel: 'rooms', streamId, streamNudgeId: 'left-stop' },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.__wskit?.streamNudgeId === 'left-stop',
    });
    expect(err.__wskit?.streamId).toBe(streamId);
    expect(err.__wskit?.streamTerminated).toBe(false);

    // The stream did not stop on the rejected nudge — it keeps emitting tokens.
    const before = (await frames(page, a)).filter(
      (f) => f.event === 'channel-tokens' && typeof f.payload?.token === 'string',
    ).length;
    await page.waitForFunction(
      ([sid, n]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'channel-tokens' && typeof f.payload?.token === 'string',
        ).length > (n as number),
      [a, before],
    );
  });
});
