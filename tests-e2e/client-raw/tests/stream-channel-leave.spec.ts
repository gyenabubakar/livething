import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';
import type { WireFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-durable-scoped';

async function joinRooms(page: Page, socket: string): Promise<void> {
  const before = (await frames(page, socket)).filter((f) => f.event === '__subscribeOk__').length;
  await send(page, socket, {
    event: '__subscribe__',
    payload: null,
    metadata: { channel: { name: 'rooms' } },
  });
  await page.waitForFunction(
    ([sid, n]) =>
      (window.__livethingFrames!(sid as string) ?? []).filter(
        (f: WireFrame) => f.event === '__subscribeOk__',
      ).length > (n as number),
    [socket, before] as const,
  );
}

async function leaveRooms(page: Page, socket: string): Promise<void> {
  await send(page, socket, {
    event: '__unsubscribe__',
    payload: null,
    metadata: { channel: { name: 'rooms', unsubscribeId: 'leave-1' } },
  });
  await waitForFrame(page, socket, { match: (f) => f.event === '__unsubscribeOk__' });
}

async function countChunks(page: Page, socket: string, event: string): Promise<number> {
  return (await frames(page, socket)).filter((f) => f.event === event).length;
}

/**
 * Leaving a channel stops every stream the connection runs in that channel.
 * The client gets a terminal `stream-aborted` error with reason `unsubscribed`,
 * and no chunk follows it. A durable stream is deleted too, so it
 * cannot be continued after joining again.
 */
test.describe('stream stops when its connection leaves the channel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/stream-durable-scoped');
    await installRig(page);
  });

  test('a plain channel stream ends with stream-aborted (unsubscribed) and sends no more chunks', async ({
    page,
  }, testInfo) => {
    const room = `scl-plain-${testInfo.testId}-${Date.now()}`;
    const streamId = 'leave-tokens-1';
    const a = await connect(page, { path: WS_PATH, username: 'alice', room });
    await joinRooms(page, a);

    await send(page, a, {
      event: 'channel-tokens',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'channel-tokens',
        ).length >= 2,
      [a],
    );

    await leaveRooms(page, a);

    const aborted = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.stream?.id === streamId,
    });
    expect(aborted.payload).toEqual({
      code: 'stream-aborted',
      detail: { reason: 'unsubscribed' },
    });
    expect(aborted.metadata?.stream?.terminated).toBe(true);

    const all = await frames(page, a);
    const abortedAt = all.indexOf(
      all.find((f) => f.event === '__error__' && f.metadata?.stream?.id === streamId)!,
    );
    expect(all.slice(abortedAt).some((f) => f.event === 'channel-tokens')).toBe(false);

    const count = await countChunks(page, a, 'channel-tokens');
    await page.waitForTimeout(400);
    expect(await countChunks(page, a, 'channel-tokens')).toBe(count);
  });

  test('a recorded channel stream is stopped and deleted, so continuing after joining again fails', async ({
    page,
  }, testInfo) => {
    const room = `scl-recorded-${testInfo.testId}-${Date.now()}`;
    const streamId = 'leave-history-1';
    const a = await connect(page, { path: WS_PATH, username: 'alice', room });
    await joinRooms(page, a);

    await send(page, a, {
      event: 'history',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === 'history' });

    await leaveRooms(page, a);

    const aborted = await waitForFrame(page, a, {
      match: (f) => f.event === '__error__' && f.metadata?.stream?.id === streamId,
    });
    expect(aborted.payload).toEqual({
      code: 'stream-aborted',
      detail: { reason: 'unsubscribed' },
    });

    const count = await countChunks(page, a, 'history');
    await page.waitForTimeout(500);
    expect(await countChunks(page, a, 'history')).toBe(count);

    await joinRooms(page, a);
    await send(page, a, {
      event: '__continueStream__',
      payload: { lastKnownSeq: 0 },
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    const continueError = await waitForFrame(page, a, {
      match: (f) =>
        f.event === '__error__' &&
        f.metadata?.stream?.id === streamId &&
        (f.payload?.detail as { reason?: string } | undefined)?.reason === 'not-found',
    });
    expect(continueError.payload?.code).toBe('stream-aborted');
  });
});
