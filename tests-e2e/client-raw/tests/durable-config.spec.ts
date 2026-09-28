import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

const WS_PATH = '/ws/durable-config';

async function openRig(page: Page) {
  await page.goto('/');
  await installRig(page);
}

function tockSeqs(
  all: { event: string; metadata?: Record<string, Record<string, unknown>> | null }[],
): number[] {
  return all
    .filter((f) => f.event === 'tock' && typeof f.metadata?.delivery?.seq === 'number')
    .map((f) => f.metadata!.delivery!.seq as number);
}

test.describe('durable-config', () => {
  test('persistent sequence continues above its prior value after a restart', async ({
    page,
    request,
  }, testInfo) => {
    const room = `dc-seq-${testInfo.testId}`;
    await openRig(page);

    const a = await connect(page, { path: WS_PATH, username: 'alice', room });
    // Climb the persistent counter with several ticks.
    for (let i = 1; i <= 6; i += 1) {
      await send(page, a, { event: 'tick', payload: {} });
      await page.waitForFunction(
        ([sid, n]) =>
          (window.__livethingFrames!(sid as string) ?? []).filter((f) => f.event === 'tock')
            .length >= (n as number),
        [a, i],
      );
    }

    const beforeSeq = Math.max(...tockSeqs(await frames(page, a)));
    expect(beforeSeq).toBeGreaterThan(0);

    // Restart the DO (ctx.abort discards in-memory state, durable storage survives).
    const res = await request.get(`${WS_PATH}/restart?room=${room}`);
    expect(res.status()).toBe(204);

    // Reconnect and tick once. A persistent counter continues ABOVE its prior
    // value (a non-persistent one would reset back to 1).
    const b = await connect(page, { path: WS_PATH, username: 'alice', room });
    await send(page, b, { event: 'tick', payload: {} });
    const tock = await waitForFrame(page, b, {
      match: (f) => f.event === 'tock' && typeof f.metadata?.delivery?.seq === 'number',
    });
    expect(tock.metadata!.delivery!.seq as number).toBeGreaterThan(beforeSeq);
  });

  test('dedup cap evicts the oldest id; a resent evicted id dispatches again', async ({
    page,
  }, testInfo) => {
    const room = `dc-dedup-${testInfo.testId}`;
    await openRig(page);
    const c = await connect(page, { path: WS_PATH, username: 'alice', room });

    // cap is 2. Ring fills A,B then C evicts A.
    await send(page, c, {
      event: 'do-echo',
      payload: { text: 'a1' },
      metadata: { delivery: { id: 'A' } },
    });
    await send(page, c, {
      event: 'do-echo',
      payload: { text: 'b1' },
      metadata: { delivery: { id: 'B' } },
    });
    await send(page, c, {
      event: 'do-echo',
      payload: { text: 'c1' },
      metadata: { delivery: { id: 'C' } },
    });
    // A was evicted, so resending it dispatches again (text a2 arrives).
    await send(page, c, {
      event: 'do-echo',
      payload: { text: 'a2' },
      metadata: { delivery: { id: 'A' } },
    });
    // C is still inside the ring, so resending it is dropped (text c2 never arrives).
    await send(page, c, {
      event: 'do-echo',
      payload: { text: 'c2' },
      metadata: { delivery: { id: 'C' } },
    });

    await waitForFrame(page, c, { match: (f) => f.event === 'echoed' && f.payload.text === 'a2' });
    await page.waitForTimeout(250);

    const texts = (await frames(page, c))
      .filter((f) => f.event === 'echoed')
      .map((f) => f.payload.text as string);
    expect(texts).toContain('a1');
    expect(texts).toContain('b1');
    expect(texts).toContain('c1');
    expect(texts).toContain('a2'); // evicted id re-dispatched

    expect(texts).not.toContain('c2'); // still-cached id dropped
  });
});
