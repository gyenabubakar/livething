import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';
import type { WireFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-durable-scoped';

async function openRig(page: Page) {
  await page.goto('/stream-durable-scoped');
  await installRig(page);
}

test.describe('stream config options', () => {
  test('allowConcurrent: true — two streams of the same event run on one connection', async ({
    page,
  }, testInfo) => {
    const room = `sco-${testInfo.testId}-${Date.now()}`;
    await openRig(page);
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });

    await send(page, a, {
      event: 'start-concurrent',
      payload: {},
      metadata: { stream: { id: 'cc-1' } },
    });
    const ok1 = await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    expect(ok1.metadata?.stream?.id).toBe('cc-1');

    await send(page, a, {
      event: 'start-concurrent',
      payload: {},
      metadata: { stream: { id: 'cc-2' } },
    });
    const ok2 = await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.metadata?.stream?.id === 'cc-2',
    });
    expect(ok2.metadata?.stream?.id).toBe('cc-2');

    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === 'cc-1',
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === 'cc-2',
    });

    const all = await frames(page, a);
    const errors = all.filter(
      (f) => f.event === '__error__' && f.payload.code === 'stream-already-active',
    );
    expect(errors).toHaveLength(0);

    const chunksCc1 = all.filter(
      (f) => f.event === 'start-concurrent' && f.metadata?.stream?.id === 'cc-1',
    );
    const chunksCc2 = all.filter(
      (f) => f.event === 'start-concurrent' && f.metadata?.stream?.id === 'cc-2',
    );
    expect(chunksCc1.length).toBeGreaterThanOrEqual(1);
    expect(chunksCc2.length).toBeGreaterThanOrEqual(1);
  });

  test('onDisconnect: keep-running — generator keeps producing after drop, continue catches up from the buffer', async ({
    page,
  }, testInfo) => {
    const room = `sco-${testInfo.testId}-${Date.now()}`;
    await openRig(page);
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });

    const streamId = 'kr-1';
    await send(page, a, {
      event: 'keep-running-feed',
      payload: {},
      metadata: { stream: { id: streamId } },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamOk__' && f.metadata?.stream?.id === streamId,
    });
    // Wait for at least one chunk before dropping so we know the generator is
    // running.
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'keep-running-feed' && typeof f.payload?.idx === 'number',
        ).length >= 1,
      [a],
    );

    await closeSocket(page, a);
    // Generator yield cadence is 80ms, so 20 chunks take 1_600ms to produce.
    // Wait ~2x that (plus past the Node fixture's former one-second
    // idle-eviction window) so a slower CI runner's event-loop delays can't
    // shrink the margin, proving socketless background work is not stopped
    // by the harness.
    await page.waitForTimeout(3_200);

    const b = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, b, {
      event: '__continueStream__',
      payload: { lastKnownSeq: 0 },
      metadata: { stream: { id: streamId } },
    });

    // Every chunk must have been produced while the client was offline.
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'keep-running-feed' && typeof f.payload?.idx === 'number',
        ).length === 20,
      [b],
    );

    const indices = (await frames(page, b))
      .filter((f) => f.event === 'keep-running-feed' && typeof f.payload?.idx === 'number')
      .map((f) => f.payload.idx as number);
    // Buffer replay carries the seq numbers from before the disconnect.
    expect(indices[0]).toBe(1);
    expect(indices.at(-1)).toBe(20);
    expect(indices).toEqual([...indices].sort((x, y) => x - y));
  });

  test('custom maxAgeMs — suspended row past the window surfaces stream-aborted expired on reconnect', async ({
    page,
  }, testInfo) => {
    const room = `sco-${testInfo.testId}-${Date.now()}`;
    await openRig(page);
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });

    const streamId = 'short-window-1';
    await send(page, a, {
      event: 'short-window',
      payload: {},
      metadata: { stream: { id: streamId } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    // Wait for one chunk so the row exists with status='active'.
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'short-window' && typeof f.payload?.row === 'number',
        ).length >= 1,
      [a],
    );

    // Drop the socket so the row goes 'suspended'. maxAgeMs is 300ms; wait
    // long enough that the suspend is well past the window.
    await closeSocket(page, a);
    await page.waitForTimeout(800);

    const b = await connect(page, { path: WS_PATH, username: 'alice', room: room });

    // The continue frame can occasionally not land under load (the reconnect
    // racing the worker), leaving no response at all. Re-send it until the
    // terminal __error__ for this `metadata.stream.id` comes back.
    let err: WireFrame | undefined;
    for (let attempt = 0; attempt < 3 && !err; attempt++) {
      await send(page, b, {
        event: '__continueStream__',
        payload: { lastKnownSeq: 0 },
        metadata: { stream: { id: streamId } },
      });
      try {
        err = await waitForFrame(page, b, {
          match: (f) => f.event === '__error__' && f.metadata?.stream?.id === streamId,
          timeoutMs: 4000,
        });
      } catch {
        // no frame yet — the loop re-sends the continue frame
      }
    }

    expect(err, 'continue did not surface a stream-aborted error after retries').toBeTruthy();
    expect(err!.payload.code).toBe('stream-aborted');
    expect((err!.payload.detail as { reason: string }).reason).toBe('expired');
  });

  test('custom retentionAfterEndMs — ended row past the window surfaces stream-aborted not-found on reconnect', async ({
    page,
  }, testInfo) => {
    const room = `sco-${testInfo.testId}-${Date.now()}`;
    await openRig(page);
    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });

    const streamId = 'short-retention-1';
    await send(page, a, {
      event: 'short-retention',
      payload: {},
      metadata: { stream: { id: streamId } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__streamOk__' });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
    });

    // retentionAfterEndMs is 300ms; wait beyond it so the row is past
    // retention even if the sweep hasn't run.
    await page.waitForTimeout(800);

    await send(page, a, {
      event: '__continueStream__',
      payload: { lastKnownSeq: 0 },
      metadata: { stream: { id: streamId } },
    });
    const err = await waitForFrame(page, a, { match: (f) => f.event === '__error__' });
    expect(err.payload.code).toBe('stream-aborted');
    expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
  });
});
