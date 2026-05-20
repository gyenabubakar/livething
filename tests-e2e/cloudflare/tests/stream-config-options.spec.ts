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

    await send(page, a, { event: 'start-concurrent', payload: { _streamId: 'cc-1' } });
    const ok1 = await waitForFrame(page, a, (f) => f.event === '_streamOk');
    expect(ok1.payload._streamId).toBe('cc-1');

    await send(page, a, { event: 'start-concurrent', payload: { _streamId: 'cc-2' } });
    const ok2 = await waitForFrame(
      page,
      a,
      (f) => f.event === '_streamOk' && f.payload._streamId === 'cc-2',
    );
    expect(ok2.payload._streamId).toBe('cc-2');

    await waitForFrame(page, a, (f) => f.event === '_streamEnd' && f.payload._streamId === 'cc-1');
    await waitForFrame(page, a, (f) => f.event === '_streamEnd' && f.payload._streamId === 'cc-2');

    const all = await frames(page, a);
    const errors = all.filter(
      (f) => f.event === '_error' && f.payload.code === 'stream-already-active',
    );
    expect(errors).toHaveLength(0);

    const chunksCc1 = all.filter(
      (f) => f.event === 'start-concurrent' && f.payload._streamId === 'cc-1',
    );
    const chunksCc2 = all.filter(
      (f) => f.event === 'start-concurrent' && f.payload._streamId === 'cc-2',
    );
    expect(chunksCc1.length).toBeGreaterThanOrEqual(1);
    expect(chunksCc2.length).toBeGreaterThanOrEqual(1);
  });

  // 'keep-running' is documented as reserved for a later release
  // (server-spec.md, "Lifecycle and configuration" table). The runtime today
  // ignores the option and treats every disconnect as 'cancel-but-buffer'.
  // Un-skip when the disconnect-path branch lands.
  test.skip('onDisconnect: keep-running — generator keeps producing after drop, resume catches up from the buffer', async () => {});

  test('custom maxAgeMs — suspended row past the window surfaces stream-aborted expired on resume', async ({
    page,
  }, testInfo) => {
    const room = `sco-${testInfo.testId}`;
    await openRig(page);
    const a = await connect(page, WS_PATH, 'alice', room);

    const streamId = 'short-window-1';
    await send(page, a, { event: 'short-window', payload: { _streamId: streamId } });
    await waitForFrame(page, a, (f) => f.event === '_streamOk');
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
      event: '_resumeStream',
      payload: { _streamId: streamId, since: 0 },
    });

    const err = await waitForFrame(page, b, (f) => f.event === '_error');
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
    await send(page, a, { event: 'short-retention', payload: { _streamId: streamId } });
    await waitForFrame(page, a, (f) => f.event === '_streamOk');
    await waitForFrame(
      page,
      a,
      (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
    );

    // retentionAfterEndMs is 300ms; wait beyond it so the row is past
    // retention even if the sweep hasn't run.
    await page.waitForTimeout(800);

    await send(page, a, {
      event: '_resumeStream',
      payload: { _streamId: streamId, since: 0 },
    });
    const err = await waitForFrame(page, a, (f) => f.event === '_error');
    expect(err.payload.code).toBe('stream-aborted');
    expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
  });
});
