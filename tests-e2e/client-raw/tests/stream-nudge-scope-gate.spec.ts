import { expect, test } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';
import type { WireFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-durable-scoped';

/**
 * A nudge for a channel-scoped stream must resolve to the stream's own scope
 * and the connection must still hold that membership. A nudge that omits the
 * channel markers is rejected non-terminally and never reaches the generator.
 * Leaving the channel stops the stream, so a later nudge is rejected too.
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
    await send(page, a, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'channel-tokens',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.metadata?.stream?.id === streamId,
    });

    // Wait for a couple of tokens so the stream is firmly running.
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'channel-tokens' && typeof f.payload?.token === 'string',
        ).length >= 2,
      [a],
    );

    // The stop nudge omits the channel markers — claimed top-level scope does
    // not match the stream's stored channel scope, so it must be rejected.
    await send(page, a, {
      event: 'stop',
      payload: {},
      metadata: { stream: { id: streamId, nudgeId: 'noscope-stop' } },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.stream?.nudgeId === 'noscope-stop',
    });
    expect(err.metadata?.stream?.id).toBe(streamId);
    expect(err.metadata?.stream?.terminated).toBe(false);

    // The nudge never reached the generator, so the stream did NOT stop: it keeps
    // producing tokens past the point a delivered stop would have ended it.
    const before = (await frames(page, a)).filter(
      (f) => f.event === 'channel-tokens' && typeof f.payload?.token === 'string',
    ).length;
    await page.waitForFunction(
      ([sid, n]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'channel-tokens' && typeof f.payload?.token === 'string',
        ).length > (n as number),
      [a, before],
    );

    // A correctly-scoped stop then ends the stream — proving the gate, not a
    // broken nudge path, blocked the first attempt.
    await send(page, a, {
      event: 'stop',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId, nudgeId: 'scoped-stop' } },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
    });
  });

  test('a nudge sent after leaving the channel is rejected and never reaches the stream', async ({
    page,
  }, testInfo) => {
    const room = `nsg-left-${testInfo.testId}-${Date.now()}`;
    const streamId = 'tokens-left-1';

    const a = await connect(page, { path: WS_PATH, username: 'alice', room });
    await send(page, a, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'channel-tokens',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.metadata?.stream?.id === streamId,
    });

    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'channel-tokens' && typeof f.payload?.token === 'string',
        ).length >= 2,
      [a],
    );

    // Leaving the channel stops the stream. The nudge sent afterwards with the
    // original channel markers finds no live stream and is rejected.
    await send(page, a, {
      event: '__unsubscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, a, {
      match: (f) =>
        f.event === '__error__' &&
        f.metadata?.stream?.id === streamId &&
        f.payload?.code === 'stream-aborted',
    });

    await send(page, a, {
      event: 'stop',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId, nudgeId: 'left-stop' } },
    });

    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.stream?.nudgeId === 'left-stop',
    });
    expect(err.metadata?.stream?.id).toBe(streamId);
    expect(err.metadata?.stream?.terminated).toBe(false);
  });
});
