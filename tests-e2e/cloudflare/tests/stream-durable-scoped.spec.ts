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

    const a = await connect(page, WS_PATH, 'alice', room);
    await send(page, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
    await waitForFrame(page, a, (f) => f.event === '_subscribeOk');

    await send(page, a, { event: 'paginate', payload: { _channel: 'rooms', _streamId: streamId } });

    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'paginate' && typeof f.payload?.row === 'number',
        ).length >= 2,
      [a],
    );

    await closeSocket(page, a);
    await page.waitForTimeout(150);

    const b = await connect(page, WS_PATH, 'alice', room);
    await send(page, b, {
      event: '_resumeStream',
      payload: { _channel: 'rooms', _streamId: streamId, since: 0 },
    });

    await waitForFrame(
      page,
      b,
      (f) =>
        f.event === '_streamEnd' &&
        f.payload._streamId === streamId &&
        f.payload._channel === 'rooms',
    );

    const firstSocketRows = (await frames(page, a))
      .filter((f) => f.event === 'paginate' && f.payload._channel === 'rooms')
      .map((f) => f.payload.row as number);
    const secondSocketRows = (await frames(page, b))
      .filter((f) => f.event === 'paginate' && f.payload._channel === 'rooms')
      .map((f) => f.payload.row as number);
    const combined = new Set([...firstSocketRows, ...secondSocketRows]);
    expect([...combined].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('channel-scoped recordedStream replays missed chunks from the buffer', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}`;
    const streamId = 'history-1';

    const a = await connect(page, WS_PATH, 'alice', room);
    await send(page, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
    await waitForFrame(page, a, (f) => f.event === '_subscribeOk');

    await send(page, a, { event: 'history', payload: { _channel: 'rooms', _streamId: streamId } });
    await waitForFrame(
      page,
      a,
      (f) =>
        f.event === '_streamEnd' &&
        f.payload._streamId === streamId &&
        f.payload._channel === 'rooms',
    );

    await closeSocket(page, a);
    await page.waitForTimeout(150);

    const b = await connect(page, WS_PATH, 'alice', room);
    await send(page, b, {
      event: '_resumeStream',
      payload: { _channel: 'rooms', _streamId: streamId, since: 2 },
    });

    await waitForFrame(
      page,
      b,
      (f) =>
        f.event === '_streamEnd' &&
        f.payload._streamId === streamId &&
        f.payload._channel === 'rooms',
    );

    const replayed = (await frames(page, b))
      .filter((f) => f.event === 'history' && f.payload._channel === 'rooms')
      .map((f) => f.payload.idx as number);
    expect(replayed).toEqual([3, 4, 5]);
  });

  test('namespace-scoped recordedStream replays via _namespace marker', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}`;
    const streamId = 'logs-1';

    const a = await connect(page, WS_PATH, 'alice', room);
    await send(page, a, {
      event: 'logs',
      payload: { _namespace: 'v1', _streamId: streamId },
    });
    await waitForFrame(
      page,
      a,
      (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
    );

    await closeSocket(page, a);
    await page.waitForTimeout(150);

    const b = await connect(page, WS_PATH, 'alice', room);
    await send(page, b, {
      event: '_resumeStream',
      payload: { _namespace: 'v1', _streamId: streamId, since: 0 },
    });

    await waitForFrame(
      page,
      b,
      (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
    );

    const lines = (await frames(page, b))
      .filter((f) => f.event === 'logs' && f.payload._namespace === 'v1')
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

      const a = await connect(pageA, WS_PATH, 'alice', room);
      await send(pageA, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
      await waitForFrame(pageA, a, (f) => f.event === '_subscribeOk');
      await send(pageA, a, {
        event: 'paginate',
        payload: { _channel: 'rooms', _streamId: streamId },
      });
      await waitForFrame(
        pageA,
        a,
        (f) => f.event === 'paginate' && typeof f.payload?.row === 'number',
      );

      const b = await connect(pageB, WS_PATH, 'bob', room);
      await send(pageB, b, {
        event: '_resumeStream',
        payload: { _channel: 'rooms', _streamId: streamId, since: 0 },
      });

      const err = await waitForFrame(pageB, b, (f) => f.event === '_error');
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

    const a = await connect(page, WS_PATH, 'alice', room);
    await send(page, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
    await waitForFrame(page, a, (f) => f.event === '_subscribeOk');

    await send(page, a, {
      event: 'paused-feed',
      payload: { _channel: 'rooms', _streamId: streamId },
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
      payload: { _channel: 'rooms', _streamId: streamId, at: Date.now() },
    });

    await waitForFrame(
      page,
      a,
      (f) =>
        f.event === '_streamEnd' &&
        f.payload._streamId === streamId &&
        f.payload._channel === 'rooms',
    );

    await page.waitForTimeout(500);
    const rowsAfter = (await frames(page, a)).filter(
      (f) => f.event === 'paused-feed' && typeof f.payload.row === 'number',
    ).length;
    expect(rowsAfter - rowsBefore).toBeLessThanOrEqual(1);
    expect(rowsAfter).toBeLessThan(20);
  });
});
