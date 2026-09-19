import { expect, test } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/stream-broadcast';

/**
 * A plain broadcast gives peers chunks tagged with `metadata.stream.id`,
 * `metadata.stream.seq`, and `metadata.stream.durability`, followed by a
 * terminal `__streamEnd__` so peers can group and complete the stream.
 */
test.describe('stream-broadcast — plain broadcast peer lifecycle', () => {
  test('a peer receives stream metadata on each chunk, then __streamEnd__', async ({
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

      // Each peer chunk carries the same stream ID, a monotonic sequence, and durability.
      const streamId = chunks[0]!.metadata?.stream?.id;
      expect(typeof streamId).toBe('string');
      for (const f of chunks) {
        expect(f.metadata?.stream?.id).toBe(streamId);
        expect(f.metadata?.stream?.durability).toBe('ephemeral');
        expect(typeof f.metadata?.stream?.seq).toBe('number');
      }

      const seqs = chunks.map((f) => f.metadata?.stream?.seq as number);
      expect(seqs[0]).toBeLessThan(seqs[1]!);

      expect(seqs[1]).toBeLessThan(seqs[2]!);

      // ...and a terminal __streamEnd__ for the same stream.
      const end = await waitForFrame(pageB, b, {
        match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
      });
      expect(typeof end.metadata?.stream?.seq).toBe('number');
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

      // Bob receives a chunk and learns `metadata.stream.id`.
      const firstChunk = await waitForFrame(pageB, b, {
        match: (f) => f.event === 'start-broadcast',
      });
      const streamId = firstChunk.metadata?.stream?.id;
      expect(typeof streamId).toBe('string');

      // Alice cancels the stream mid-flight.
      await send(pageA, a, {
        event: '__streamCancel__',
        payload: null,
        metadata: { stream: { id: streamId } },
      });

      // Bob receives the terminal __streamEnd__ when Alice cancels the stream.
      const end = await waitForFrame(pageB, b, {
        match: (f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId,
      });
      expect(end.metadata?.stream?.event).toBe('start-broadcast');
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
        match: (f) => f.event === '__error__' && f.metadata?.stream?.terminated === true,
      });
      const streamId = errB.metadata?.stream?.id;
      expect(typeof streamId).toBe('string');
      expect(errB.payload.code).toBe('internal-error');

      // The creator gets the same terminal error for the same stream.
      const errA = await waitForFrame(pageA, a, {
        match: (f) =>
          f.event === '__error__' &&
          f.metadata?.stream?.terminated === true &&
          f.metadata?.stream?.id === streamId,
      });
      expect(errA.payload.code).toBe('internal-error');

      // The peer must NOT also receive a misleading clean end for this stream.
      const peerFrames = await frames(pageB, b);
      expect(
        peerFrames.some((f) => f.event === '__streamEnd__' && f.metadata?.stream?.id === streamId),
      ).toBe(false);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
