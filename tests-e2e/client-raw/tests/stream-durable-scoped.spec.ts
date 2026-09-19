import { expect, test } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';
import type { WireFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-durable-scoped';

test.describe('stream-durable scoped (channel)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/stream-durable-scoped');
    await installRig(page);
  });

  test('channel-scoped resumableStream survives reconnect via persistence auto-rejoin', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}-${Date.now()}`;
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
    expect(rejoin.__wskit?.source).toBe('server');

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

  test('channel-scoped resumableStream resume is live: continues from the latest cursor, no replay of seen rows', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}-${Date.now()}`;
    const streamId = 'paginate-rewind-1';

    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'paginate',
      payload: {},
      __wskit: { channel: 'rooms', streamId },
    });

    // Receive rows 1 and 2, then drop the socket while the stream is still live.
    await page.waitForFunction(
      ([sid]) =>
        (window.__wskitFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'paginate' && typeof f.payload?.row === 'number',
        ).length >= 2,
      [a],
    );
    await closeSocket(page, a);
    await page.waitForTimeout(150);

    // Reconnect and resume claiming seq 2 — the highest seq this client got.
    const b = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, b, {
      match: (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'rooms',
    });
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

    const resumedRows = (await frames(page, b))
      .filter((f) => f.event === 'paginate' && f.__wskit?.channel === 'rooms')
      .map((f) => f.payload.row as number);

    // The client confirmed rows 1 and 2, so the resumed socket does not receive
    // them again. It gets the contiguous tail through row 10.
    expect(resumedRows.length).toBeGreaterThan(0);
    expect(resumedRows).not.toContain(1);
    expect(resumedRows).not.toContain(2);
    expect(resumedRows[0]).toBeGreaterThanOrEqual(3);
    expect(resumedRows[resumedRows.length - 1]).toBe(10);

    const expectedTail = Array.from(
      { length: resumedRows.length },
      (_, i) => 10 - resumedRows.length + 1 + i,
    );
    expect(resumedRows).toEqual(expectedTail);
  });

  test('channel-scoped recordedStream replays missed chunks from the buffer', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}-${Date.now()}`;
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

  test('non-member resume of a channel-scoped stream returns not-found', async ({
    browser,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}-${Date.now()}`;
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
    const room = `sds-${testInfo.testId}-${Date.now()}`;
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
    // The pause stops the stream well before its natural end of 20. A few more
    // rows may still arrive before the generator notices the pause — how many
    // depends on the generator's own loop, not on wskit, so we don't check an
    // exact number.
    expect(rowsAfter).toBeLessThan(20);
  });

  // A pause nudge ends this generator attempt. A reconnect must still start a
  // new attempt from the last row this client confirmed, because the browser
  // may have missed items before it saw the old end frame.
  test('an ended resumable stream restarts from the client-confirmed row on resume', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}-${Date.now()}`;
    const streamId = 'paused-resume-1';

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

    const rowsBeforeDrop = (await frames(page, a)).filter(
      (f) => f.event === 'paused-feed' && typeof f.payload.row === 'number',
    );
    const rowSeqs = rowsBeforeDrop
      .map((f) => f.__wskit?.seq)
      .filter((seq): seq is number => typeof seq === 'number');
    expect(rowSeqs).not.toHaveLength(0);
    const lastKnownSeq = Math.max(...rowSeqs);

    await closeSocket(page, a);
    await page.waitForTimeout(150);

    const b = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    const rejoin = await waitForFrame(page, b, {
      match: (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'rooms',
    });
    expect(rejoin.__wskit?.source).toBe('server');

    await send(page, b, {
      event: '__resumeStream__',
      payload: { lastKnownSeq },
      __wskit: { channel: 'rooms', streamId },
    });

    await waitForFrame(page, b, {
      match: (f) =>
        f.event === '__streamEnd__' &&
        f.__wskit?.streamId === streamId &&
        f.__wskit?.channel === 'rooms',
    });

    const rowsAfterResume = (await frames(page, b))
      .filter((f) => f.event === 'paused-feed' && typeof f.payload.row === 'number')
      .map((f) => f.payload.row as number);

    expect(rowsAfterResume).toEqual(
      Array.from({ length: 20 - lastKnownSeq }, (_, i) => lastKnownSeq + i + 1),
    );
    expect(rowsBeforeDrop.length).toBeLessThan(20);
  });
});
