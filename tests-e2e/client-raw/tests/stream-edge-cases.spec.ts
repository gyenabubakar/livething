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
    await send(page, a, { event: 'boom-mid', payload: {}, metadata: { stream: { id: streamId } } });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.metadata?.stream?.id === streamId,
    });

    // Two pre-throw chunks arrive, then the generator throws and the engine
    // sends an __error__ frame with the same `metadata.stream.id`.
    await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.stream?.id === streamId,
    });

    const all = await frames(page, a);
    const chunks = all.filter((f) => f.event === 'boom-mid' && typeof f.payload?.idx === 'number');
    expect(chunks.map((c) => c.payload.idx)).toEqual([1, 2]);

    const err = all.find((f) => f.event === '__error__' && f.metadata?.stream?.id === streamId)!;
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
    await send(page, a, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    // Unique per run: this stream sleeps 60s and never ends, so a fixed id
    // would leave an active durable row behind that collides on the next run.
    const streamId = `attempt-broadcast-${Date.now()}`;
    await send(page, a, {
      event: 'attempt-broadcast',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
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
    await send(page, b, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, b, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, b, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 1 },
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });

    // Resumable is live (no replay): the creator-resume re-runs the generator
    // from the latest cursor with attempt=2, producing a brand-new chunk.
    const next = await waitForFrame(page, b, {
      match: (f) =>
        f.event === 'attempt-broadcast' &&
        typeof f.payload?.attempt === 'number' &&
        f.metadata?.stream?.seq !== 1,
      timeoutMs: 10_000,
    });
    expect(next.payload.attempt).toBe(2);
  });

  test('a supplied metadata.stream.id pins a channel-scoped durable stream resume key', async ({
    page,
  }, testInfo) => {
    const room = `sec-${testInfo.testId}-${Date.now()}`;
    await openRig(page, '/stream-durable-scoped');
    const a = await connect(page, {
      path: '/ws/stream-durable-scoped',
      username: 'alice',
      room: room,
    });
    await send(page, a, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    const streamId = 'pinned-channel-id';
    await send(page, a, {
      event: 'history',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    const ok = await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    expect(ok.metadata?.stream?.id).toBe(streamId);
    expect(ok.metadata?.channel?.name).toBe('rooms');

    await waitForFrame(page, a, {
      match: (f) =>
        f.event === 'history' &&
        typeof f.payload?.idx === 'number' &&
        f.metadata?.stream?.id === streamId &&
        f.metadata?.channel?.name === 'rooms',
    });

    await closeSocket(page, a);
    await page.waitForTimeout(150);
    const b = await connect(page, {
      path: '/ws/stream-durable-scoped',
      username: 'alice',
      room: room,
    });
    await send(page, b, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, b, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, b, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    await waitForFrame(page, b, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
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
      metadata: { stream: { id: 'first' } },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.metadata?.stream?.id === 'first',
    });
    // Wait for at least one chunk so the generator is definitely running.
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).some((f) => f.event === 'start-tokens'),
      [a],
    );

    await send(page, a, {
      event: 'start-tokens',
      payload: { count: 10 },
      metadata: { stream: { id: 'second' } },
    });
    const err = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.payload.code === 'stream-already-active',
    });
    expect(err.payload.code).toBe('stream-already-active');

    // Connection is alive — cancel the first stream.
    await send(page, a, {
      event: '__streamCancel__',
      payload: null,
      metadata: { stream: { id: 'first' } },
    });
  });
});
