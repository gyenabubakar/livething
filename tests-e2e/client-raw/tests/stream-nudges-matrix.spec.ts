import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-durable-scoped';

async function openRig(page: Page) {
  await page.goto('/stream-durable-scoped');
  await installRig(page);
}

async function countChunks(page: Page, id: string, event: string): Promise<number> {
  return (await frames(page, id)).filter((f) => f.event === event).length;
}

test.describe('stream-nudges matrix', () => {
  test('plain stream() in a channel — nudge stops the generator mid-flight', async ({
    page,
  }, testInfo) => {
    const room = `snm-${testInfo.testId}-${Date.now()}`;
    await openRig(page);
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, a, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'channel-tokens',
      payload: {},
      metadata: { channel: { name: 'rooms' } },
    });
    const ok = await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    const streamId = ok.metadata?.stream?.id as string;
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'channel-tokens' && typeof f.payload?.token === 'string',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: 'stop',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
    });

    const tokens = await countChunks(page, a, 'channel-tokens');
    expect(tokens).toBeLessThan(20);
    expect(tokens).toBeGreaterThanOrEqual(1);
  });

  test('recordedStream in a channel — nudge stops the generator mid-flight', async ({
    page,
  }, testInfo) => {
    const room = `snm-${testInfo.testId}-${Date.now()}`;
    await openRig(page);
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, a, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    const streamId = 'history-nudged-1';
    await send(page, a, {
      event: 'history-nudged',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'history-nudged' && typeof f.payload?.idx === 'number',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: 'stop',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
    });

    const chunks = await countChunks(page, a, 'history-nudged');
    expect(chunks).toBeLessThan(20);
    expect(chunks).toBeGreaterThanOrEqual(1);
  });

  test('a peer cannot nudge another connection’s stream — gets validation-failed, owner unaffected', async ({
    page,
  }, testInfo) => {
    // A nudge frame must reference a live stream owned by the SAME connection.
    // Bob sending a 'stop' with Alice's `metadata.stream.id` must be rejected with
    // validation-failed, and alice's generator must keep producing — one
    // client cannot steer another's stream.
    const room = `snm-cross-${testInfo.testId}-${Date.now()}`;
    await openRig(page);
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    const b = await connect(page, { path: WS_PATH, username: 'bob', room: room });
    for (const c of [a, b]) {
      await send(page, c, {
        event: '__subscribe__',
        payload: null,
        metadata: { channel: { name: 'rooms' } },
      });
      await waitForFrame(page, c, { match: (f) => f.event === '__subscribeOk__' });
    }

    await send(page, a, {
      event: 'channel-tokens',
      payload: {},
      metadata: { channel: { name: 'rooms' } },
    });
    const ok = await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    const streamId = ok.metadata?.stream?.id as string;
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).some((f) => f.event === 'channel-tokens'),
      [a],
    );

    // Bob tries to stop alice's stream by its id.
    const tokensWhenNudged = await countChunks(page, a, 'channel-tokens');
    await send(page, b, {
      event: 'stop',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });

    // Bob is told the stream is not his.
    const err = await waitForFrame(page, b, {
      match: (f) => f.event === '__error__' && f.payload.code === 'validation-failed',
    });
    expect(err.metadata?.stream?.id).toBe(streamId);

    // Alice's stream is unaffected — it keeps producing past the nudge point.
    await page.waitForFunction(
      ([sid, cnt]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter((f) => f.event === 'channel-tokens')
          .length > (cnt as number),
      [a, tokensWhenNudged],
    );
  });

  test('cursorStream in a channel — nudge stops the generator mid-flight', async ({
    page,
  }, testInfo) => {
    const room = `snm-res-ch-${testInfo.testId}-${Date.now()}`;
    await openRig(page);
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, a, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    const streamId = 'paused-feed-1';
    await send(page, a, {
      event: 'paused-feed',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'paused-feed' && typeof f.payload?.row === 'number',
        ).length >= 1,
      [a],
    );

    await send(page, a, {
      event: 'pause',
      payload: { at: 1 },
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
    });

    const chunks = await countChunks(page, a, 'paused-feed');
    expect(chunks).toBeLessThan(20);
    expect(chunks).toBeGreaterThanOrEqual(1);
  });

  test('top-level recordedStream — nudge stops the generator mid-flight', async ({
    page,
  }, testInfo) => {
    const room = `snm-rec-top-${testInfo.testId}-${Date.now()}`;
    await openRig(page);
    const a = await connect(page, { path: '/ws/stream-durable', username: 'alice', room: room });

    const streamId = 'count-tokens-nudged-1';
    await send(page, a, {
      event: 'count-tokens-nudged',
      payload: {},
      metadata: { stream: { id: streamId } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'count-tokens-nudged' && typeof f.payload?.idx === 'number',
        ).length >= 1,
      [a],
    );

    await send(page, a, { event: 'stop', payload: {}, metadata: { stream: { id: streamId } } });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
    });

    const chunks = await countChunks(page, a, 'count-tokens-nudged');
    expect(chunks).toBeLessThan(20);
    expect(chunks).toBeGreaterThanOrEqual(1);
  });

  test('top-level cursorStream — nudge stops the generator mid-flight', async ({
    page,
  }, testInfo) => {
    const room = `snm-res-top-${testInfo.testId}-${Date.now()}`;
    await openRig(page);
    const a = await connect(page, { path: '/ws/stream-durable', username: 'alice', room: room });

    const streamId = 'paginate-nudged-1';
    await send(page, a, {
      event: 'paginate-nudged',
      payload: {},
      metadata: { stream: { id: streamId } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'paginate-nudged' && typeof f.payload?.row === 'number',
        ).length >= 1,
      [a],
    );

    await send(page, a, { event: 'stop', payload: {}, metadata: { stream: { id: streamId } } });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
    });

    const chunks = await countChunks(page, a, 'paginate-nudged');
    expect(chunks).toBeLessThan(20);
    expect(chunks).toBeGreaterThanOrEqual(1);
  });
});
