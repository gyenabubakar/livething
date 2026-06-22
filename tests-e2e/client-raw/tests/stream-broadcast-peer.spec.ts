import { expect, test } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-broadcast';

/**
 * A plain (non-durable) broadcast must give peers the full lifecycle: chunks
 * tagged with streamId + seq + streamKind, and a terminal __streamEnd__. Before
 * the server fix, peer chunks carried no streamId and no end frame, so a client
 * could neither group nor complete the stream.
 */
test.describe('stream-broadcast — plain broadcast peer lifecycle', () => {
  test('a peer receives chunks tagged with streamId/seq/streamKind, then __streamEnd__', async ({
    browser,
  }: {
    browser: Browser;
  }, testInfo) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto('/stream-broadcast');
    await installRig(pageA);
    await pageB.goto('/stream-broadcast');
    await installRig(pageB);
    try {
      const room = `sbp-${testInfo.testId}-${Date.now()}`;
      const a = await connect(pageA, { path: WS_PATH, username: 'alice', room });
      const b = await connect(pageB, { path: WS_PATH, username: 'bob', room });

      // Alice triggers a top-level plain broadcast; Bob is a passive peer.
      await send(pageA, a, { event: 'start-broadcast', payload: { count: 3 } });

      // Bob receives every chunk.
      await waitForFrame(pageB, b, {
        match: (f) =>
          f.event === 'start-broadcast' && (f.payload as { index?: number }).index === 2,
      });
      const chunks = (await frames(pageB, b)).filter((f) => f.event === 'start-broadcast');
      expect(chunks.map((f) => (f.payload as { index: number }).index)).toEqual([0, 1, 2]);

      // Each peer chunk carries the same streamId, a monotonic seq, and streamKind.
      const streamId = chunks[0]!.__wskit?.streamId;
      expect(typeof streamId).toBe('string');
      for (const f of chunks) {
        expect(f.__wskit?.streamId).toBe(streamId);
        expect(f.__wskit?.streamKind).toBe('ephemeral');
        expect(typeof f.__wskit?.seq).toBe('number');
      }
      const seqs = chunks.map((f) => f.__wskit?.seq as number);
      expect(seqs[0]).toBeLessThan(seqs[1]!);
      expect(seqs[1]).toBeLessThan(seqs[2]!);

      // ...and a terminal __streamEnd__ for the same stream.
      const end = await waitForFrame(pageB, b, {
        match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
      });
      expect(typeof end.__wskit?.seq).toBe('number');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('a creator cancel fans a terminal __streamEnd__ out to every peer', async ({
    browser,
  }: {
    browser: Browser;
  }, testInfo) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto('/stream-broadcast');
    await installRig(pageA);
    await pageB.goto('/stream-broadcast');
    await installRig(pageB);
    try {
      const room = `sbc-${testInfo.testId}-${Date.now()}`;
      const a = await connect(pageA, { path: WS_PATH, username: 'alice', room });
      const b = await connect(pageB, { path: WS_PATH, username: 'bob', room });

      // A long-running broadcast (100 chunks × 10ms) so a cancel lands mid-stream.
      await send(pageA, a, { event: 'start-broadcast', payload: { count: 100 } });

      // Bob receives a chunk and learns the streamId.
      const firstChunk = await waitForFrame(pageB, b, {
        match: (f) => f.event === 'start-broadcast',
      });
      const streamId = firstChunk.__wskit?.streamId;
      expect(typeof streamId).toBe('string');

      // Alice cancels the stream mid-flight.
      await send(pageA, a, { event: '__streamCancel__', payload: {}, __wskit: { streamId } });

      // Bob must get a terminal __streamEnd__ for that stream — before the fix the
      // cancel path notified no peers, so Bob's run hung until socket close.
      const end = await waitForFrame(pageB, b, {
        match: (f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId,
      });
      expect(end.__wskit?.eventName).toBe('start-broadcast');
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('a creator-generator error fans a terminal __error__ to the creator and every peer', async ({
    browser,
  }: {
    browser: Browser;
  }, testInfo) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto('/stream-broadcast');
    await installRig(pageA);
    await pageB.goto('/stream-broadcast');
    await installRig(pageB);
    try {
      const room = `sbe-${testInfo.testId}-${Date.now()}`;
      const a = await connect(pageA, { path: WS_PATH, username: 'alice', room });
      const b = await connect(pageB, { path: WS_PATH, username: 'bob', room });

      // Negative count makes the generator yield one chunk then throw.
      await send(pageA, a, { event: 'start-broadcast', payload: { count: -1 } });

      // The peer is told the stream broke — a terminal __error__, not a clean end.
      const errB = await waitForFrame(pageB, b, {
        match: (f) => f.event === '__error__' && f.__wskit?.streamTerminated === true,
      });
      const streamId = errB.__wskit?.streamId;
      expect(typeof streamId).toBe('string');
      expect(errB.payload.code).toBe('internal-error');

      // The creator gets the same terminal error for the same stream.
      const errA = await waitForFrame(pageA, a, {
        match: (f) =>
          f.event === '__error__' &&
          f.__wskit?.streamTerminated === true &&
          f.__wskit?.streamId === streamId,
      });
      expect(errA.payload.code).toBe('internal-error');

      // The peer must NOT also receive a misleading clean end for this stream.
      const peerFrames = await frames(pageB, b);
      expect(
        peerFrames.some((f) => f.event === '__streamEnd__' && f.__wskit?.streamId === streamId),
      ).toBe(false);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
