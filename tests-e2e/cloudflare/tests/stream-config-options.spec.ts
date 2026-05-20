import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-durable-scoped';

async function openRig(page: Page) {
  await page.goto('/stream-durable-scoped');
  await installRig(page);
}

test.describe('stream config options', () => {
  test('allowConcurrent: true — two streams of the same event run on one connection', async ({
    page,
  }, testInfo) => {
    const room = `sco-${testInfo.testId}`;
    await openRig(page);
    const a = await connect(page, WS_PATH, 'alice', room);

    await send(page, a, { event: 'start-concurrent', payload: {}, __wskit: { streamId: 'cc-1' } });
    const ok1 = await waitForFrame(page, a, (f) => f.event === '__streamOk__');
    expect(ok1.__wskit?.streamId).toBe('cc-1');

    await send(page, a, { event: 'start-concurrent', payload: {}, __wskit: { streamId: 'cc-2' } });
    const ok2 = await waitForFrame(
      page,
      a,
      (f) => f.event === '__streamOk__' && f.__wskit?.streamId === 'cc-2',
    );
    expect(ok2.__wskit?.streamId).toBe('cc-2');

    await waitForFrame(
      page,
      a,
      (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === 'cc-1',
    );
    await waitForFrame(
      page,
      a,
      (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === 'cc-2',
    );

    const all = await frames(page, a);
    const errors = all.filter(
      (f) => f.event === '__error__' && f.payload.code === 'stream-already-active',
    );
    expect(errors).toHaveLength(0);

    const chunksCc1 = all.filter(
      (f) => f.event === 'start-concurrent' && f.__wskit?.streamId === 'cc-1',
    );
    const chunksCc2 = all.filter(
      (f) => f.event === 'start-concurrent' && f.__wskit?.streamId === 'cc-2',
    );
    expect(chunksCc1.length).toBeGreaterThanOrEqual(1);
    expect(chunksCc2.length).toBeGreaterThanOrEqual(1);
  });

  test('onDisconnect: keep-running — generator keeps producing after drop, resume catches up from the buffer', async ({
    page,
  }, testInfo) => {
    const room = `sco-${testInfo.testId}`;
    await openRig(page);
    const a = await connect(page, WS_PATH, 'alice', room);

    const streamId = 'kr-1';
    await send(page, a, { event: 'keep-running-feed', payload: {}, __wskit: { streamId } });
    await waitForFrame(
      page,
      a,
      (f) => f.event === '__streamOk__' && f.__wskit?.streamId === streamId,
    );
    // Wait for at least one chunk before dropping so we know the generator is
    // running.
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'keep-running-feed' && typeof f.payload?.idx === 'number',
        ).length >= 1,
      [a],
    );

    await closeSocket(page, a);
    // Generator yield cadence is 80ms; wait long enough that several more
    // chunks have landed in the buffer while we were offline.
    await page.waitForTimeout(800);

    const b = await connect(page, WS_PATH, 'alice', room);
    await send(page, b, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { streamId },
    });

    // Wait for the resume to deliver at least the chunks produced while we
    // were offline. Don't run to completion — the test only needs to prove
    // the catch-up window worked.
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'keep-running-feed' && typeof f.payload?.idx === 'number',
        ).length >= 5,
      [b],
    );

    const indices = (await frames(page, b))
      .filter((f) => f.event === 'keep-running-feed' && typeof f.payload?.idx === 'number')
      .map((f) => f.payload.idx as number);
    // Buffer replay carries the seq numbers from before the disconnect.
    expect(indices[0]).toBe(1);
    expect(indices).toEqual([...indices].sort((x, y) => x - y));
  });

  test('custom maxAgeMs — suspended row past the window surfaces stream-aborted expired on resume', async ({
    page,
  }, testInfo) => {
    const room = `sco-${testInfo.testId}`;
    await openRig(page);
    const a = await connect(page, WS_PATH, 'alice', room);

    const streamId = 'short-window-1';
    await send(page, a, { event: 'short-window', payload: {}, __wskit: { streamId } });
    await waitForFrame(page, a, (f) => f.event === '__streamOk__');
    // Wait for one chunk so the row exists with status='active'.
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f) => f.event === 'short-window' && typeof f.payload?.row === 'number',
        ).length >= 1,
      [a],
    );

    // Drop the socket so the row goes 'suspended'. maxAgeMs is 300ms; wait
    // long enough that the suspend is well past the window.
    await closeSocket(page, a);
    await page.waitForTimeout(800);

    const b = await connect(page, WS_PATH, 'alice', room);
    await send(page, b, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { streamId },
    });

    const err = await waitForFrame(page, b, (f) => f.event === '__error__');
    expect(err.payload.code).toBe('stream-aborted');
    expect((err.payload.detail as { reason: string }).reason).toBe('expired');
  });

  test('custom retentionAfterEndMs — ended row past the window surfaces stream-aborted not-found on resume', async ({
    page,
  }, testInfo) => {
    const room = `sco-${testInfo.testId}`;
    await openRig(page);
    const a = await connect(page, WS_PATH, 'alice', room);

    const streamId = 'short-retention-1';
    await send(page, a, { event: 'short-retention', payload: {}, __wskit: { streamId } });
    await waitForFrame(page, a, (f) => f.event === '__streamOk__');
    await waitForFrame(
      page,
      a,
      (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    );

    // retentionAfterEndMs is 300ms; wait beyond it so the row is past
    // retention even if the sweep hasn't run.
    await page.waitForTimeout(800);

    await send(page, a, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { streamId },
    });
    const err = await waitForFrame(page, a, (f) => f.event === '__error__');
    expect(err.payload.code).toBe('stream-aborted');
    expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
  });
});
