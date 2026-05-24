import { expect, test } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';
import type { WireFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-durable-scoped';

test.describe('stream-durable scoped (channel + namespace)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/stream-durable-scoped');
    await installRig(page);
  });

  test('channel-scoped resumableStream survives reconnect via persistence auto-rejoin', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}`;
    const streamId = 'paginate-1';

    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'paginate',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });

    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'paginate' && typeof f.payload?.row === 'number',
        ).length >= 2,
      [a],
    );

    await closeSocket(page, a);
    await page.waitForTimeout(150);

    const b = await connect(page, { path: WS_PATH, username: 'alice', room: room });

    // Persistence auto-rejoins alice's prior channel membership on the new
    // socket — the server-emitted __subscribeOk__ carries source: 'server'. If
    // this assertion ever fails, the rest of the test would only fail with
    // a misleading not-found error, so verify it directly first.
    const rejoin = await waitForFrame(page, b, {
      match: (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'rooms',
    });
    expect(rejoin.payload.source).toBe('server');

    await send(page, b, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { channel: 'rooms', streamId },
    });

    await waitForFrame(page, b, {
      match: (f) =>
        f.event === '__streamEnd__' &&
        f.__wskit?.streamId === streamId &&
        f.__wskit?.channel === 'rooms',
    });

    const firstSocketRows = (await frames(page, a))
      .filter((f) => f.event === 'paginate' && f.__wskit?.channel === 'rooms')
      .map((f) => f.payload.row as number);
    const secondSocketRows = (await frames(page, b))
      .filter((f) => f.event === 'paginate' && f.__wskit?.channel === 'rooms')
      .map((f) => f.payload.row as number);
    const combined = new Set([...firstSocketRows, ...secondSocketRows]);
    expect([...combined].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('channel-scoped recordedStream replays missed chunks from the buffer', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}`;
    const streamId = 'history-1';

    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'history',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });
    await waitForFrame(page, a, {
      match: (f) =>
        f.event === '__streamEnd__' &&
        f.__wskit?.streamId === streamId &&
        f.__wskit?.channel === 'rooms',
    });

    await closeSocket(page, a);
    await page.waitForTimeout(150);

    const b = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, b, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 2 },
      __wskit: { channel: 'rooms', streamId },
    });

    await waitForFrame(page, b, {
      match: (f) =>
        f.event === '__streamEnd__' &&
        f.__wskit?.streamId === streamId &&
        f.__wskit?.channel === 'rooms',
    });

    const replayed = (await frames(page, b))
      .filter((f) => f.event === 'history' && f.__wskit?.channel === 'rooms')
      .map((f) => f.payload.idx as number);
    expect(replayed).toEqual([3, 4, 5]);
  });

  test('namespace-scoped recordedStream replays via _namespace marker', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}`;
    const streamId = 'logs-1';

    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, a, {
      event: 'logs',
      payload: {},
      __wskit: { namespace: 'v1', streamId },
    });
    await waitForFrame(page, a, {
      match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    });

    await closeSocket(page, a);
    await page.waitForTimeout(150);

    const b = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, b, {
      event: '__resumeStream__',
      payload: { lastKnownSeq: 0 },
      __wskit: { namespace: 'v1', streamId },
    });

    await waitForFrame(page, b, {
      match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
    });

    const lines = (await frames(page, b))
      .filter((f) => f.event === 'logs' && f.__wskit?.namespace === 'v1')
      .map((f) => f.payload.line as string);
    expect(lines).toEqual(['line-1', 'line-2', 'line-3', 'line-4', 'line-5']);
  });

  test('non-member resume of a channel-scoped stream returns not-found', async ({
    browser,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}`;
    const streamId = 'shared-1';

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await pageA.goto('/stream-durable-scoped');
      await installRig(pageA);
      await pageB.goto('/stream-durable-scoped');
      await installRig(pageB);

      const a = await connect(pageA, { path: WS_PATH, username: 'alice', room: room });
      await send(pageA, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageA, a, { match: (f) => f.event === '__subscribeOk__' });
      await send(pageA, a, {
        event: 'paginate',
        payload: {},
        __wskit: { channel: 'rooms', streamId },
      });
      await waitForFrame(pageA, a, {
        match: (f) => f.event === 'paginate' && typeof f.payload?.row === 'number',
      });

      const b = await connect(pageB, { path: WS_PATH, username: 'bob', room: room });
      await send(pageB, b, {
        event: '__resumeStream__',
        payload: { lastKnownSeq: 0 },
        __wskit: { channel: 'rooms', streamId },
      });

      const err = await waitForFrame(pageB, b, { match: (f) => f.event === '__error__' });
      expect(err.payload.code).toBe('stream-aborted');
      expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('nudge on a channel-scoped resumable stream pauses the generator', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}`;
    const streamId = 'paused-1';

    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'paused-feed',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });

    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'paused-feed' && typeof f.payload?.row === 'number',
        ).length >= 2,
      [a],
    );

    const rowsBefore = (await frames(page, a)).filter(
      (f) => f.event === 'paused-feed' && typeof f.payload.row === 'number',
    ).length;

    await send(page, a, {
      event: 'pause',
      payload: { at: Date.now() },
      __wskit: { channel: 'rooms', streamId },
    });

    await waitForFrame(page, a, {
      match: (f) =>
        f.event === '__streamEnd__' &&
        f.__wskit?.streamId === streamId &&
        f.__wskit?.channel === 'rooms',
    });

    await page.waitForTimeout(500);
    const rowsAfter = (await frames(page, a)).filter(
      (f) => f.event === 'paused-feed' && typeof f.payload.row === 'number',
    ).length;
    expect(rowsAfter - rowsBefore).toBeLessThanOrEqual(1);
    expect(rowsAfter).toBeLessThan(20);
  });
});
