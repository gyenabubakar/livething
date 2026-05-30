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
    const room = `sdbc-${testInfo.testId}-${Date.now()}`;
    const streamId = 'feed-1';
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, { path: WS_PATH, username: 'alice', room: room });
      const b = await connect(pageB, { path: WS_PATH, username: 'bob', room: room });
      await send(pageA, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageA, a, { match: (f) => f.event === '__subscribeOk__' });
      await send(pageB, b, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageB, b, { match: (f) => f.event === '__subscribeOk__' });

      await send(pageA, a, {
        event: 'feed',
        payload: {},
        __wskit: { channel: 'rooms', streamId },
      });

      await waitForFrame(pageA, a, {
        match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
      });
      await waitForFrame(pageB, b, {
        match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
      });

      const tokensA = (await frames(pageA, a))
        .filter((f) => f.event === 'feed' && f.__wskit?.channel === 'rooms')
        .map((f) => f.payload.token as string);
      const tokensB = (await frames(pageB, b))
        .filter((f) => f.event === 'feed' && f.__wskit?.channel === 'rooms')
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
    const room = `sdbc-${testInfo.testId}-${Date.now()}`;
    const streamId = 'feed-2';
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, { path: WS_PATH, username: 'alice', room: room });
      await send(pageA, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageA, a, { match: (f) => f.event === '__subscribeOk__' });
      await send(pageA, a, {
        event: 'feed',
        payload: {},
        __wskit: { channel: 'rooms', streamId },
      });

      await pageA.waitForFunction(
        ([sid]) =>
          (window.__wskitFrames!(sid as string) ?? []).filter(
            (f: WireFrame) => f.event === 'feed' && typeof f.payload?.token === 'string',
          ).length >= 3,
        [a],
      );

      const b = await connect(pageB, { path: WS_PATH, username: 'bob', room: room });
      await send(pageB, b, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageB, b, { match: (f) => f.event === '__subscribeOk__' });
      await send(pageB, b, {
        event: '__resumeStream__',
        payload: { lastKnownSeq: 0 },
        __wskit: { channel: 'rooms', streamId },
      });

      await waitForFrame(pageB, b, {
        match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
      });
      const tokensB = (await frames(pageB, b))
        .filter((f) => f.event === 'feed' && f.__wskit?.channel === 'rooms')
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
    const room = `sdbc-${testInfo.testId}-${Date.now()}`;
    const streamId = 'pg-1';
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, { path: WS_PATH, username: 'alice', room: room });
      await send(pageA, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageA, a, { match: (f) => f.event === '__subscribeOk__' });
      await send(pageA, a, {
        event: 'paginate',
        payload: {},
        __wskit: { channel: 'rooms', streamId },
      });

      await pageA.waitForFunction(
        ([sid]) =>
          (window.__wskitFrames!(sid as string) ?? []).filter(
            (f: WireFrame) => f.event === 'paginate' && typeof f.payload?.row === 'number',
          ).length >= 2,
        [a],
      );

      const b = await connect(pageB, { path: WS_PATH, username: 'bob', room: room });
      await send(pageB, b, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageB, b, { match: (f) => f.event === '__subscribeOk__' });
      await send(pageB, b, {
        event: '__resumeStream__',
        payload: { lastKnownSeq: 0 },
        __wskit: { channel: 'rooms', streamId },
      });

      await waitForFrame(pageB, b, {
        match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
        timeoutMs: 10_000,
      });
      const rowsB = (await frames(pageB, b))
        .filter((f) => f.event === 'paginate' && f.__wskit?.channel === 'rooms')
        .map((f) => f.payload.row as number);
      expect(rowsB).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('creator cancel kills the source for everyone', async ({ browser }, testInfo) => {
    const room = `sdbc-${testInfo.testId}-${Date.now()}`;
    const streamId = 'feed-cancel-1';
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, { path: WS_PATH, username: 'alice', room: room });
      const b = await connect(pageB, { path: WS_PATH, username: 'bob', room: room });
      await send(pageA, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageA, a, { match: (f) => f.event === '__subscribeOk__' });
      await send(pageB, b, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageB, b, { match: (f) => f.event === '__subscribeOk__' });

      await send(pageA, a, {
        event: 'feed',
        payload: {},
        __wskit: { channel: 'rooms', streamId },
      });
      await pageB.waitForFunction(
        ([sid]) =>
          (window.__wskitFrames!(sid as string) ?? []).filter(
            (f: WireFrame) => f.event === 'feed' && typeof f.payload?.token === 'string',
          ).length >= 2,
        [b],
      );

      await send(pageA, a, {
        event: '__streamCancel__',
        payload: {},
        __wskit: { channel: 'rooms', streamId },
      });

      // Let in-flight tokens flush, then assert the stream truly stopped by
      // confirming the count does not grow across a second window. Comparing
      // pre/post-cancel counts is racey under load — a few tokens can slip
      // through between the snapshot read and the cancel taking effect.
      await pageA.waitForTimeout(700);
      const bTokensSettled = (await frames(pageB, b)).filter((f) => f.event === 'feed').length;
      await pageA.waitForTimeout(500);
      const bTokensFinal = (await frames(pageB, b)).filter((f) => f.event === 'feed').length;
      expect(bTokensFinal).toBe(bTokensSettled);
      expect(bTokensFinal).toBeLessThan(10);

      // Both the peer AND the creator see not-found — the row is gone for
      // everyone, not just unsubscribed for one peer.
      await send(pageB, b, {
        event: '__resumeStream__',
        payload: { lastKnownSeq: 0 },
        __wskit: { channel: 'rooms', streamId },
      });
      const errB = await waitForFrame(pageB, b, { match: (f) => f.event === '__error__' });
      expect(errB.payload.code).toBe('stream-aborted');
      expect((errB.payload.detail as { reason: string }).reason).toBe('not-found');

      await send(pageA, a, {
        event: '__resumeStream__',
        payload: { lastKnownSeq: 0 },
        __wskit: { channel: 'rooms', streamId },
      });
      const errA = await waitForFrame(pageA, a, { match: (f) => f.event === '__error__' });
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
    const room = `sdbc-${testInfo.testId}-${Date.now()}`;
    const streamId = 'feed-self-cancel-1';
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, { path: WS_PATH, username: 'alice', room: room });
      const b = await connect(pageB, { path: WS_PATH, username: 'bob', room: room });
      await send(pageA, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageA, a, { match: (f) => f.event === '__subscribeOk__' });
      await send(pageB, b, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageB, b, { match: (f) => f.event === '__subscribeOk__' });

      await send(pageA, a, {
        event: 'feed',
        payload: {},
        __wskit: { channel: 'rooms', streamId },
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
        event: '__streamCancel__',
        payload: {},
        __wskit: { channel: 'rooms', streamId },
      });

      await waitForFrame(pageA, a, {
        match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
        timeoutMs: 10_000,
      });

      const bTokensAfter = (await frames(pageB, b)).filter((f) => f.event === 'feed').length;
      expect(bTokensAfter - bTokensBefore).toBeLessThanOrEqual(1);

      const aTokens = (await frames(pageA, a))
        .filter((f) => f.event === 'feed' && f.__wskit?.channel === 'rooms')
        .map((f) => f.payload.token as string);
      expect(aTokens).toEqual(['t1', 't2', 't3', 't4', 't5']);

      await send(pageB, b, {
        event: '__resumeStream__',
        payload: { lastKnownSeq: 0 },
        __wskit: { channel: 'rooms', streamId },
      });
      const err = await waitForFrame(pageB, b, { match: (f) => f.event === '__error__' });
      expect(err.payload.code).toBe('stream-aborted');
      expect((err.payload.detail as { reason: string }).reason).toBe('unsubscribed');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('creator nudge on a broadcast stream stops the fan-out for every peer', async ({
    browser,
  }, testInfo) => {
    const room = `sdbc-nudge-${testInfo.testId}-${Date.now()}`;
    // Unique per run so a prior ended/retained row never blocks the next start.
    const streamId = `feed-nudged-${Date.now()}`;
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, { path: WS_PATH, username: 'alice', room: room });
      const b = await connect(pageB, { path: WS_PATH, username: 'bob', room: room });
      await send(pageA, a, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageA, a, { match: (f) => f.event === '__subscribeOk__' });
      await send(pageB, b, { event: '__subscribe__', payload: {}, __wskit: { channel: 'rooms' } });
      await waitForFrame(pageB, b, { match: (f) => f.event === '__subscribeOk__' });

      // Alice (creator) starts the broadcast stream; both see chunks fan out.
      await send(pageA, a, {
        event: 'feed-nudged',
        payload: {},
        __wskit: { channel: 'rooms', streamId },
      });
      await waitForFrame(pageA, a, {
        match: (f) => f.event === 'feed-nudged' && typeof f.payload?.token === 'string',
      });
      await waitForFrame(pageB, b, {
        match: (f) => f.event === 'feed-nudged' && typeof f.payload?.token === 'string',
      });

      // The creator nudges 'stop'. Because the generator runs on the creator's
      // connection and fans out to peers, the stop ends the stream for everyone.
      await send(pageA, a, {
        event: 'stop',
        payload: {},
        __wskit: { channel: 'rooms', streamId },
      });

      await waitForFrame(pageA, a, {
        match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
      });
      await waitForFrame(pageB, b, {
        match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
      });

      // The nudge stopped it early — far fewer than the 20 it would otherwise
      // produce — and bob (the peer) stopped receiving too.
      const tokensB = (await frames(pageB, b)).filter((f) => f.event === 'feed-nudged');
      expect(tokensB.length).toBeGreaterThanOrEqual(1);
      expect(tokensB.length).toBeLessThan(20);
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
    const room = `sdbn-${testInfo.testId}-${Date.now()}`;
    const streamId = 'news-1';
    const { ctxA, ctxB, pageA, pageB } = await newPair(browser);
    try {
      const a = await connect(pageA, { path: WS_PATH, username: 'alice', room: room });
      const b = await connect(pageB, { path: WS_PATH, username: 'bob', room: room });

      await send(pageA, a, {
        event: 'news',
        payload: {},
        __wskit: { namespace: 'v1', streamId },
      });

      await waitForFrame(pageA, a, {
        match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
      });
      await waitForFrame(pageB, b, {
        match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
      });

      const headlinesA = (await frames(pageA, a))
        .filter((f) => f.event === 'news' && f.__wskit?.namespace === 'v1')
        .map((f) => f.payload.headline as string);
      const headlinesB = (await frames(pageB, b))
        .filter((f) => f.event === 'news' && f.__wskit?.namespace === 'v1')
        .map((f) => f.payload.headline as string);
      expect(headlinesA).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
      expect(headlinesB).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);

      // Bob drops, reconnects, resumes via the namespace marker. The row is
      // keyed by the namespace broadcast scope key, not by bob's identity,
      // so the resume has to carry the namespace.
      await closeSocket(pageB, b);
      await pageB.waitForTimeout(150);
      const b2 = await connect(pageB, { path: WS_PATH, username: 'bob', room: room });
      await send(pageB, b2, {
        event: '__resumeStream__',
        payload: { lastKnownSeq: 0 },
        __wskit: { namespace: 'v1', streamId },
      });
      await waitForFrame(pageB, b2, {
        match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
      });
      const replayed = (await frames(pageB, b2))
        .filter((f) => f.event === 'news' && f.__wskit?.namespace === 'v1')
        .map((f) => f.payload.headline as string);
      expect(replayed).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
