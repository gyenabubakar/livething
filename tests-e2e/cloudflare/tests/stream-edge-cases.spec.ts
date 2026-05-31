import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

async function openRig(page: Page, route: string) {
  await page.goto(route);
  await installRig(page);
}

test.describe('stream edge cases', () => {
  test('generator throws mid-stream on a durable stream — chunks land then client receives _error', async ({
    page,
  }, testInfo) => {
    const room = `sec-${testInfo.testId}-${Date.now()}`;
    await openRig(page, '/stream-durable-scoped');
    const a = await connect(page, {
      path: '/ws/stream-durable-scoped',
      username: 'alice',
      room: room,
    });

    const streamId = 'boom-mid-1';
    await send(page, a, { event: 'boom-mid', payload: {}, __wskit: { streamId } });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.__wskit?.streamId === streamId,
    });

    // Two pre-throw chunks arrive, then the generator throws and the engine
    // sends an __error__ frame correlated by streamId.
    await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.__wskit?.streamId === streamId,
    });

    const all = await frames(page, a);
    const chunks = all.filter((f) => f.event === 'boom-mid' && typeof f.payload?.idx === 'number');
    expect(chunks.map((c) => c.payload.idx)).toEqual([1, 2]);

    const err = all.find((f) => f.event === '__error__' && f.__wskit?.streamId === streamId)!;
    // The throw is a plain Error — the framework wraps it as internal-error
    // to avoid leaking server internals to the client.
    expect(err.payload.code).toBe('internal-error');
  });

  test('ctx.stream.attempt on a broadcast resumable creator-resume equals 2 on the second run', async ({
    page,
  }, testInfo) => {
    const room = `sec-${testInfo.testId}-${Date.now()}`;
    await openRig(page, '/stream-durable-broadcast');
    const a = await connect(page, {
      path: '/ws/stream-durable-broadcast',
      username: 'alice',
      room: room,
    });
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    // Unique per run: this stream sleeps 60s and never ends, so a fixed id
    // would leave an active durable row behind that collides on the next run.
    const streamId = `attempt-broadcast-${Date.now()}`;
    await send(page, a, {
      event: 'attempt-broadcast',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });
    const firstChunk = await waitForFrame(page, a, {
      match: (f) => f.event === 'attempt-broadcast' && typeof f.payload?.attempt === 'number',
    });
    expect(firstChunk.payload.attempt).toBe(1);

    // Drop + reconnect as the same identity (creator).
    await closeSocket(page, a);
    await page.waitForTimeout(150);
    const b = await connect(page, {
      path: '/ws/stream-durable-broadcast',
      username: 'alice',
      room: room,
    });
    await send(page, b, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, b, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, b, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 1 },
      __wskit: { channel: 'rooms', streamId },
    });

    // After replay of the first chunk, the creator-resume re-runs the
    // generator with attempt=2.
    const next = await waitForFrame(page, b, {
      match: (f) =>
        f.event === 'attempt-broadcast' &&
        typeof f.payload?.attempt === 'number' &&
        f.__wskit?.seq !== 1,
      timeoutMs: 10_000,
    });
    expect(next.payload.attempt).toBe(2);
  });

  test('dev-supplied _streamId on a channel-scoped durable stream pins the resume key', async ({
    page,
  }, testInfo) => {
    const room = `sec-${testInfo.testId}-${Date.now()}`;
    await openRig(page, '/stream-durable-scoped');
    const a = await connect(page, {
      path: '/ws/stream-durable-scoped',
      username: 'alice',
      room: room,
    });
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    const streamId = 'pinned-channel-id';
    await send(page, a, {
      event: 'history',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });
    const ok = await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    expect(ok.__wskit?.streamId).toBe(streamId);
    expect(ok.__wskit?.channel).toBe('rooms');

    await waitForFrame(page, a, {
      match: (f) =>
        f.event === 'history' &&
        typeof f.payload?.idx === 'number' &&
        f.__wskit?.streamId === streamId &&
        f.__wskit?.channel === 'rooms',
    });

    await closeSocket(page, a);
    await page.waitForTimeout(150);
    const b = await connect(page, {
      path: '/ws/stream-durable-scoped',
      username: 'alice',
      room: room,
    });
    await send(page, b, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, b, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, b, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { channel: 'rooms', streamId },
    });
    await waitForFrame(page, b, {
      match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    });
  });

  test('default allowConcurrent (false) — second start of the same event → _error stream-already-active', async ({
    page,
  }, testInfo) => {
    // start-tokens is a plain stream() with no allowConcurrent flag, so the
    // default (false) applies. While the first run is still producing, a
    // second start of the same event on the same connection must be rejected
    // with stream-already-active — the counterpart to the allowConcurrent:true
    // case proven in stream-config-options.
    const room = `sec-saa-${testInfo.testId}-${Date.now()}`;
    await openRig(page, '/stream-basic');
    const a = await connect(page, { path: '/ws/stream-basic', username: 'alice', room: room });

    await send(page, a, {
      event: 'start-tokens',
      payload: { count: 10 },
      __wskit: { streamId: 'first' },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.__wskit?.streamId === 'first',
    });
    // Wait for at least one chunk so the generator is definitely running.
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).some((f) => f.event === 'start-tokens'),
      [a],
    );

    await send(page, a, {
      event: 'start-tokens',
      payload: { count: 10 },
      __wskit: { streamId: 'second' },
    });
    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.payload.code === 'stream-already-active',
    });
    expect(err.payload.code).toBe('stream-already-active');

    // Connection is alive — cancel the first stream.
    await send(page, a, { event: '__streamCancel__', payload: {}, __wskit: { streamId: 'first' } });
  });

  test('dev-supplied _streamId on a namespace-scoped durable stream pins the resume key', async ({
    page,
  }, testInfo) => {
    const room = `sec-${testInfo.testId}-${Date.now()}`;
    await openRig(page, '/stream-durable-scoped');
    const a = await connect(page, {
      path: '/ws/stream-durable-scoped',
      username: 'alice',
      room: room,
    });

    const streamId = 'pinned-ns-id';
    await send(page, a, {
      event: 'logs',
      payload: {},
      __wskit: { namespace: 'v1', streamId },
    });
    const ok = await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    expect(ok.__wskit?.streamId).toBe(streamId);
    expect(ok.__wskit?.namespace).toBe('v1');

    await waitForFrame(page, a, {
      match: (f) =>
        f.event === 'logs' &&
        typeof f.payload?.line === 'string' &&
        f.__wskit?.streamId === streamId &&
        f.__wskit?.namespace === 'v1',
    });

    await closeSocket(page, a);
    await page.waitForTimeout(150);
    const b = await connect(page, {
      path: '/ws/stream-durable-scoped',
      username: 'alice',
      room: room,
    });
    await send(page, b, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { namespace: 'v1', streamId },
    });
    await waitForFrame(page, b, {
      match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    });
  });
});
