import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { closeSocket, connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';
import type { WireFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-durable-broadcast';

async function newPair(browser: Browser): Promise<{
  ctxA: BrowserContext;
  ctxB: BrowserContext;
  pageA: Page;
  pageB: Page;
}> {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await pageA.goto('/stream-durable-broadcast');
  await installRig(pageA);
  await pageB.goto('/stream-durable-broadcast');
  await installRig(pageB);
  return { ctxA, ctxB, pageA, pageB };
}

test.describe('stream-durable broadcast (channel scope)', () => {
  test('recordedStream with broadcast fans out to channel peers live', async ({
    browser,
  }, testInfo) => {
    const room = `sdbc-${testInfo.testId}`;
    const streamId = 'feed-1';
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, WS_PATH, 'alice', room);
      const b = await connect(pageB, WS_PATH, 'bob', room);
      await send(pageA, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
      await waitForFrame(pageA, a, (f) => f.event === '_subscribeOk');
      await send(pageB, b, { event: '_subscribe', payload: { _channel: 'rooms' } });
      await waitForFrame(pageB, b, (f) => f.event === '_subscribeOk');

      await send(pageA, a, {
        event: 'feed',
        payload: { _channel: 'rooms', _streamId: streamId },
      });

      await waitForFrame(
        pageA,
        a,
        (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
      );
      await waitForFrame(
        pageB,
        b,
        (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
      );

      const tokensA = (await frames(pageA, a))
        .filter((f) => f.event === 'feed' && f.payload._channel === 'rooms')
        .map((f) => f.payload.token as string);
      const tokensB = (await frames(pageB, b))
        .filter((f) => f.event === 'feed' && f.payload._channel === 'rooms')
        .map((f) => f.payload.token as string);
      expect(tokensA).toEqual(['t1', 't2', 't3', 't4', 't5']);
      expect(tokensB).toEqual(['t1', 't2', 't3', 't4', 't5']);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('late joiner catches up from the recorded buffer plus the live tail', async ({
    browser,
  }, testInfo) => {
    const room = `sdbc-${testInfo.testId}`;
    const streamId = 'feed-2';
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, WS_PATH, 'alice', room);
      await send(pageA, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
      await waitForFrame(pageA, a, (f) => f.event === '_subscribeOk');
      await send(pageA, a, {
        event: 'feed',
        payload: { _channel: 'rooms', _streamId: streamId },
      });

      await pageA.waitForFunction(
        ([sid]) =>
          (window.__wskitFrames!(sid as string) ?? []).filter(
            (f: WireFrame) => f.event === 'feed' && typeof f.payload?.token === 'string',
          ).length >= 3,
        [a],
      );

      const b = await connect(pageB, WS_PATH, 'bob', room);
      await send(pageB, b, { event: '_subscribe', payload: { _channel: 'rooms' } });
      await waitForFrame(pageB, b, (f) => f.event === '_subscribeOk');
      await send(pageB, b, {
        event: '_resumeStream',
        payload: { _channel: 'rooms', _streamId: streamId, since: 0 },
      });

      await waitForFrame(
        pageB,
        b,
        (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
      );
      const tokensB = (await frames(pageB, b))
        .filter((f) => f.event === 'feed' && f.payload._channel === 'rooms')
        .map((f) => f.payload.token as string);
      expect(tokensB).toEqual(['t1', 't2', 't3', 't4', 't5']);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('broadcast resumableStream — late joiner gets buffered rows plus the live tail', async ({
    browser,
  }, testInfo) => {
    const room = `sdbc-${testInfo.testId}`;
    const streamId = 'pg-1';
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, WS_PATH, 'alice', room);
      await send(pageA, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
      await waitForFrame(pageA, a, (f) => f.event === '_subscribeOk');
      await send(pageA, a, {
        event: 'paginate',
        payload: { _channel: 'rooms', _streamId: streamId },
      });

      await pageA.waitForFunction(
        ([sid]) =>
          (window.__wskitFrames!(sid as string) ?? []).filter(
            (f: WireFrame) => f.event === 'paginate' && typeof f.payload?.row === 'number',
          ).length >= 2,
        [a],
      );

      const b = await connect(pageB, WS_PATH, 'bob', room);
      await send(pageB, b, { event: '_subscribe', payload: { _channel: 'rooms' } });
      await waitForFrame(pageB, b, (f) => f.event === '_subscribeOk');
      await send(pageB, b, {
        event: '_resumeStream',
        payload: { _channel: 'rooms', _streamId: streamId, since: 0 },
      });

      await waitForFrame(
        pageB,
        b,
        (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
        10_000,
      );
      const rowsB = (await frames(pageB, b))
        .filter((f) => f.event === 'paginate' && f.payload._channel === 'rooms')
        .map((f) => f.payload.row as number);
      expect(rowsB).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('creator cancel kills the source for everyone', async ({ browser }, testInfo) => {
    const room = `sdbc-${testInfo.testId}`;
    const streamId = 'feed-cancel-1';
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, WS_PATH, 'alice', room);
      const b = await connect(pageB, WS_PATH, 'bob', room);
      await send(pageA, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
      await waitForFrame(pageA, a, (f) => f.event === '_subscribeOk');
      await send(pageB, b, { event: '_subscribe', payload: { _channel: 'rooms' } });
      await waitForFrame(pageB, b, (f) => f.event === '_subscribeOk');

      await send(pageA, a, {
        event: 'feed',
        payload: { _channel: 'rooms', _streamId: streamId },
      });
      await pageB.waitForFunction(
        ([sid]) =>
          (window.__wskitFrames!(sid as string) ?? []).filter(
            (f: WireFrame) => f.event === 'feed' && typeof f.payload?.token === 'string',
          ).length >= 2,
        [b],
      );

      const bTokensBefore = (await frames(pageB, b)).filter((f) => f.event === 'feed').length;

      await send(pageA, a, {
        event: '_streamCancel',
        payload: { _channel: 'rooms', _streamId: streamId },
      });

      await pageA.waitForTimeout(700);
      const bTokensAfter = (await frames(pageB, b)).filter((f) => f.event === 'feed').length;
      expect(bTokensAfter - bTokensBefore).toBeLessThanOrEqual(1);
      expect(bTokensAfter).toBeLessThan(5);

      // Both the peer AND the creator see not-found — the row is gone for
      // everyone, not just unsubscribed for one peer.
      await send(pageB, b, {
        event: '_resumeStream',
        payload: { _channel: 'rooms', _streamId: streamId, since: 0 },
      });
      const errB = await waitForFrame(pageB, b, (f) => f.event === '_error');
      expect(errB.payload.code).toBe('stream-aborted');
      expect((errB.payload.detail as { reason: string }).reason).toBe('not-found');

      await send(pageA, a, {
        event: '_resumeStream',
        payload: { _channel: 'rooms', _streamId: streamId, since: 0 },
      });
      const errA = await waitForFrame(pageA, a, (f) => f.event === '_error');
      expect(errA.payload.code).toBe('stream-aborted');
      expect((errA.payload.detail as { reason: string }).reason).toBe('not-found');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('non-creator cancel unsubscribes self but does not kill the source', async ({
    browser,
  }, testInfo) => {
    const room = `sdbc-${testInfo.testId}`;
    const streamId = 'feed-self-cancel-1';
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, WS_PATH, 'alice', room);
      const b = await connect(pageB, WS_PATH, 'bob', room);
      await send(pageA, a, { event: '_subscribe', payload: { _channel: 'rooms' } });
      await waitForFrame(pageA, a, (f) => f.event === '_subscribeOk');
      await send(pageB, b, { event: '_subscribe', payload: { _channel: 'rooms' } });
      await waitForFrame(pageB, b, (f) => f.event === '_subscribeOk');

      await send(pageA, a, {
        event: 'feed',
        payload: { _channel: 'rooms', _streamId: streamId },
      });
      await pageB.waitForFunction(
        ([sid]) =>
          (window.__wskitFrames!(sid as string) ?? []).filter(
            (f: WireFrame) => f.event === 'feed' && typeof f.payload?.token === 'string',
          ).length >= 1,
        [b],
      );

      const bTokensBefore = (await frames(pageB, b)).filter((f) => f.event === 'feed').length;

      await send(pageB, b, {
        event: '_streamCancel',
        payload: { _channel: 'rooms', _streamId: streamId },
      });

      await waitForFrame(
        pageA,
        a,
        (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
        10_000,
      );

      const bTokensAfter = (await frames(pageB, b)).filter((f) => f.event === 'feed').length;
      expect(bTokensAfter - bTokensBefore).toBeLessThanOrEqual(1);

      const aTokens = (await frames(pageA, a))
        .filter((f) => f.event === 'feed' && f.payload._channel === 'rooms')
        .map((f) => f.payload.token as string);
      expect(aTokens).toEqual(['t1', 't2', 't3', 't4', 't5']);

      await send(pageB, b, {
        event: '_resumeStream',
        payload: { _channel: 'rooms', _streamId: streamId, since: 0 },
      });
      const err = await waitForFrame(pageB, b, (f) => f.event === '_error');
      expect(err.payload.code).toBe('stream-aborted');
      expect((err.payload.detail as { reason: string }).reason).toBe('unsubscribed');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

test.describe('stream-durable broadcast (namespace scope)', () => {
  test('namespace-scoped recordedStream fans out to every connection, peer reconnect replays from buffer', async ({
    browser,
  }, testInfo) => {
    const room = `sdbn-${testInfo.testId}`;
    const streamId = 'news-1';
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, WS_PATH, 'alice', room);
      const b = await connect(pageB, WS_PATH, 'bob', room);

      await send(pageA, a, {
        event: 'news',
        payload: { _namespace: 'v1', _streamId: streamId },
      });

      await waitForFrame(
        pageA,
        a,
        (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
      );
      await waitForFrame(
        pageB,
        b,
        (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
      );

      const headlinesA = (await frames(pageA, a))
        .filter((f) => f.event === 'news' && f.payload._namespace === 'v1')
        .map((f) => f.payload.headline as string);
      const headlinesB = (await frames(pageB, b))
        .filter((f) => f.event === 'news' && f.payload._namespace === 'v1')
        .map((f) => f.payload.headline as string);
      expect(headlinesA).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
      expect(headlinesB).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);

      // Bob drops, reconnects, resumes via the namespace marker. The row is
      // keyed by the namespace broadcast scope key, not by bob's identity,
      // so the resume has to carry _namespace.
      await closeSocket(pageB, b);
      await pageB.waitForTimeout(150);
      const b2 = await connect(pageB, WS_PATH, 'bob', room);
      await send(pageB, b2, {
        event: '_resumeStream',
        payload: { _namespace: 'v1', _streamId: streamId, since: 0 },
      });
      await waitForFrame(
        pageB,
        b2,
        (f) => f.event === '_streamEnd' && f.payload._streamId === streamId,
      );
      const replayed = (await frames(pageB, b2))
        .filter((f) => f.event === 'news' && f.payload._namespace === 'v1')
        .map((f) => f.payload.headline as string);
      expect(replayed).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
