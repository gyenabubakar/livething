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
    const room = `sec-${testInfo.testId}`;
    await openRig(page, '/stream-durable-scoped');
    const a = await connect(page, '/ws/stream-durable-scoped', 'alice', room);

    const streamId = 'boom-mid-1';
    await send(page, a, { event: 'boom-mid', payload: { _streamId: streamId } });
    await waitForFrame(page, a, (f) => f.event === '_streamOk' && f.payload._streamId === streamId);

    // Two pre-throw chunks arrive, then the generator throws and the engine
    // sends an _error frame correlated by _streamId.
    await waitForFrame(page, a, (f) => f.event === '_error' && f.payload._streamId === streamId);

    const all = await frames(page, a);
    const chunks = all.filter((f) => f.event === 'boom-mid' && typeof f.payload?.idx === 'number');
    expect(chunks.map((c) => c.payload.idx)).toEqual([1, 2]);

    const err = all.find((f) => f.event === '_error' && f.payload._streamId === streamId)!;
    // The throw is a plain Error — the framework wraps it as internal-error
    // to avoid leaking server internals to the client.
    expect(err.payload.code).toBe('internal-error');
  });

  test('ctx.stream.attempt on a broadcast resumable creator-resume equals 2 on the second run', async ({
    page,
  }, testInfo) => {
    const room = `sec-${testInfo.testId}`;
    await openRig(page, '/stream-durable-broadcast');
    const a = await connect(page, '/ws/stream-durable-broadcast', 'alice', room);
    await send(page, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
    await waitForFrame(page, a, (f) => f.event === '_subscribeOk');

    const streamId = 'attempt-broadcast-1';
    await send(page, a, {
      event: 'attempt-broadcast',
      payload: { _channel: 'rooms', _streamId: streamId },
    });
    const firstChunk = await waitForFrame(
      page,
      a,
      (f) => f.event === 'attempt-broadcast' && typeof f.payload?.attempt === 'number',
    );
    expect(firstChunk.payload.attempt).toBe(1);

    // Drop + reconnect as the same identity (creator).
    await closeSocket(page, a);
    await page.waitForTimeout(150);
    const b = await connect(page, '/ws/stream-durable-broadcast', 'alice', room);
    await send(page, b, { event: '_subscribe', payload: { _channel: 'rooms' } });
    await waitForFrame(page, b, (f) => f.event === '_subscribeOk');

    await send(page, b, {
      event: '_resumeStream',
      payload: { _channel: 'rooms', _streamId: streamId, since: 1 },
    });

    // After replay of the first chunk, the creator-resume re-runs the
    // generator with attempt=2.
    const next = await waitForFrame(
      page,
      b,
      (f) =>
        f.event === 'attempt-broadcast' &&
        typeof f.payload?.attempt === 'number' &&
        f.payload._seq !== 1,
      10_000,
    );
    expect(next.payload.attempt).toBe(2);
  });

  test('dev-supplied _streamId on a channel-scoped durable stream pins the resume key', async ({
    page,
  }, testInfo) => {
    const room = `sec-${testInfo.testId}`;
    await openRig(page, '/stream-durable-scoped');
    const a = await connect(page, '/ws/stream-durable-scoped', 'alice', room);
    await send(page, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
    await waitForFrame(page, a, (f) => f.event === '_subscribeOk');

    const streamId = 'pinned-channel-id';
    await send(page, a, {
      event: 'history',
      payload: { _channel: 'rooms', _streamId: streamId },
    });
    const ok = await waitForFrame(page, a, (f) => f.event === '_streamOk');
    expect(ok.payload._streamId).toBe(streamId);
    expect(ok.payload._channel).toBe('rooms');

    await waitForFrame(
      page,
      a,
      (f) =>
        f.event === 'history' &&
        typeof f.payload?.idx === 'number' &&
        f.payload._streamId === streamId &&
        f.payload._channel === 'rooms',
    );

    await closeSocket(page, a);
    await page.waitForTimeout(150);
    const b = await connect(page, '/ws/stream-durable-scoped', 'alice', room);
    await send(page, b, { event: '_subscribe', payload: { _channel: 'rooms' } });
    await waitForFrame(page, b, (f) => f.event === '_subscribeOk');

    await send(page, b, {
      event: '_resumeStream',
      payload: { _channel: 'rooms', _streamId: streamId, since: 0 },
    });
    await waitForFrame(
      page,
      b,
      (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
    );
  });

  test('dev-supplied _streamId on a namespace-scoped durable stream pins the resume key', async ({
    page,
  }, testInfo) => {
    const room = `sec-${testInfo.testId}`;
    await openRig(page, '/stream-durable-scoped');
    const a = await connect(page, '/ws/stream-durable-scoped', 'alice', room);

    const streamId = 'pinned-ns-id';
    await send(page, a, {
      event: 'logs',
      payload: { _namespace: 'v1', _streamId: streamId },
    });
    const ok = await waitForFrame(page, a, (f) => f.event === '_streamOk');
    expect(ok.payload._streamId).toBe(streamId);
    expect(ok.payload._namespace).toBe('v1');

    await waitForFrame(
      page,
      a,
      (f) =>
        f.event === 'logs' &&
        typeof f.payload?.line === 'string' &&
        f.payload._streamId === streamId &&
        f.payload._namespace === 'v1',
    );

    await closeSocket(page, a);
    await page.waitForTimeout(150);
    const b = await connect(page, '/ws/stream-durable-scoped', 'alice', room);
    await send(page, b, {
      event: '_resumeStream',
      payload: { _namespace: 'v1', _streamId: streamId, since: 0 },
    });
    await waitForFrame(
      page,
      b,
      (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
    );
  });
});
