import { expect, test } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';
import type { WireFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-durable-scoped';

test.describe('stream-durable scoped (channel)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/stream-durable-scoped');
    await installRig(page);
  });

  test('channel-scoped recordedStream survives reconnect via persistence auto-rejoin', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}-${Date.now()}`;
    const streamId = 'paginate-1';

    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, a, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'paginate',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });

    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'paginate' && typeof f.payload?.row === 'number',
        ).length >= 2,
      [a],
    );

    await closeSocket(page, a);
    // closeSocket() doesn't wait for the close handshake to finish server
    // side, so give the disconnect real time to land before reconnecting
    // with the same identity (auto-rejoin depends on it).
    await page.waitForTimeout(300);

    const b = await connect(page, { path: WS_PATH, username: 'alice', room: room });

    // Persistence auto-rejoins alice's prior channel membership on the new
    // socket — the server-emitted __subscribeOk__ carries source: 'server'. If
    // this assertion ever fails, the rest of the test would only fail with
    // a misleading not-found error, so verify it directly first.
    const rejoin = await waitForFrame(page, b, {
      match: (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === 'rooms',
    });
    expect(rejoin.metadata?.exchange?.source).toBe('server');

    await send(page, b, {
      event: '__continueStream__',
      payload: { lastKnownSeq: 0 },
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });

    await waitForFrame(page, b, {
      match: (f) =>
        f.event === '__streamEnd__' &&
        f.metadata?.stream?.id === streamId &&
        f.metadata?.channel?.name === 'rooms',
    });

    const firstSocketRows = (await frames(page, a))
      .filter((f) => f.event === 'paginate' && f.metadata?.channel?.name === 'rooms')
      .map((f) => f.payload.row as number);
    const secondSocketRows = (await frames(page, b))
      .filter((f) => f.event === 'paginate' && f.metadata?.channel?.name === 'rooms')
      .map((f) => f.payload.row as number);
    const combined = new Set([...firstSocketRows, ...secondSocketRows]);
    expect([...combined].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('channel-scoped recordedStream continue sends only the rows after lastKnownSeq', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}-${Date.now()}`;
    const streamId = 'paginate-rewind-1';

    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, a, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'paginate',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });

    // Receive rows 1 and 2, then drop the socket while the stream is still live.
    await page.waitForFunction(
      ([sid]) =>
        (window.__livethingFrames!(sid as string) ?? []).filter(
          (f: WireFrame) => f.event === 'paginate' && typeof f.payload?.row === 'number',
        ).length >= 2,
      [a],
    );
    await closeSocket(page, a);
    // closeSocket() doesn't wait for the close handshake to finish server
    // side, so give the disconnect real time to land before reconnecting
    // with the same identity (auto-rejoin depends on it).
    await page.waitForTimeout(300);

    // Reconnect and continue claiming seq 2 — the highest seq this client got.
    const b = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await waitForFrame(page, b, {
      match: (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === 'rooms',
    });
    await send(page, b, {
      event: '__continueStream__',
      payload: { lastKnownSeq: 2 },
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    await waitForFrame(page, b, {
      match: (f) =>
        f.event === '__streamEnd__' &&
        f.metadata?.stream?.id === streamId &&
        f.metadata?.channel?.name === 'rooms',
    });

    const continuedRows = (await frames(page, b))
      .filter((f) => f.event === 'paginate' && f.metadata?.channel?.name === 'rooms')
      .map((f) => f.payload.row as number);

    // The client confirmed rows 1 and 2, so the continued socket does not receive
    // them again. It gets the contiguous tail through row 10.
    expect(continuedRows.length).toBeGreaterThan(0);
    expect(continuedRows).not.toContain(1);
    expect(continuedRows).not.toContain(2);
    expect(continuedRows[0]).toBeGreaterThanOrEqual(3);
    expect(continuedRows[continuedRows.length - 1]).toBe(10);

    const expectedTail = Array.from(
      { length: continuedRows.length },
      (_, i) => 10 - continuedRows.length + 1 + i,
    );
    expect(continuedRows).toEqual(expectedTail);
  });

  test('channel-scoped recordedStream replays missed chunks from the buffer', async ({
    page,
  }, testInfo) => {
    const room = `sds-${testInfo.testId}-${Date.now()}`;
    const streamId = 'history-1';

    const a = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, a, {
      event: '__subscribe__',
      payload: null,
      metadata: { channel: { name: 'rooms' } },
    });
    await waitForFrame(page, a, { match: (f) => f.event === '__subscribeOk__' });

    await send(page, a, {
      event: 'history',
      payload: {},
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });
    await waitForFrame(page, a, {
      match: (f) =>
        f.event === '__streamEnd__' &&
        f.metadata?.stream?.id === streamId &&
        f.metadata?.channel?.name === 'rooms',
    });

    await closeSocket(page, a);
    // closeSocket() doesn't wait for the close handshake to finish server
    // side, so give the disconnect real time to land before reconnecting
    // with the same identity (auto-rejoin depends on it).
    await page.waitForTimeout(300);

    const b = await connect(page, { path: WS_PATH, username: 'alice', room: room });
    await send(page, b, {
      event: '__continueStream__',
      payload: { lastKnownSeq: 2 },
      metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
    });

    await waitForFrame(page, b, {
      match: (f) =>
        f.event === '__streamEnd__' &&
        f.metadata?.stream?.id === streamId &&
        f.metadata?.channel?.name === 'rooms',
    });

    const replayed = (await frames(page, b))
      .filter((f) => f.event === 'history' && f.metadata?.channel?.name === 'rooms')
      .map((f) => f.payload.idx as number);
    expect(replayed).toEqual([3, 4, 5]);
  });

  test('non-member continue of a channel-scoped stream returns not-found', async ({
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
      await send(pageA, a, {
        event: '__subscribe__',
        payload: null,
        metadata: { channel: { name: 'rooms' } },
      });
      await waitForFrame(pageA, a, { match: (f) => f.event === '__subscribeOk__' });
      await send(pageA, a, {
        event: 'paginate',
        payload: {},
        metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
      });
      await waitForFrame(pageA, a, {
        match: (f) => f.event === 'paginate' && typeof f.payload?.row === 'number',
      });

      const b = await connect(pageB, { path: WS_PATH, username: 'bob', room: room });
      await send(pageB, b, {
        event: '__continueStream__',
        payload: { lastKnownSeq: 0 },
        metadata: { channel: { name: 'rooms' }, stream: { id: streamId } },
      });

      const err = await waitForFrame(pageB, b, { match: (f) => f.event === '__error__' });
      expect(err.payload.code).toBe('stream-aborted');
      expect((err.payload.detail as { reason: string }).reason).toBe('not-found');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
