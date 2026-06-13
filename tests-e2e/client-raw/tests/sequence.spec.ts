import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect, frames, installRig, send } from './_ws-rig.ts';

async function tickAndReadSeq(page: Page, prev: number): Promise<number> {
  await page.getByTestId('tick').click();
  await expect
    .poll(async () => Number((await page.getByTestId('last-seq').textContent()) || '0'))
    .toBeGreaterThan(prev);
  return Number((await page.getByTestId('last-seq').textContent()) || '0');
}

test.describe('sequence', () => {
  test('outgoing frames carry an incrementing seq number', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/sequence?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('tick').click();
    await expect(page.getByTestId('last-seq')).toHaveText(/[1-9]\d*/);
  });

  test('sequence increments across multiple outgoing messages', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/sequence?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    const first = await tickAndReadSeq(page, 0);
    const second = await tickAndReadSeq(page, first);
    const third = await tickAndReadSeq(page, second);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  test('sequence is monotonically increasing', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/sequence?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    const history: number[] = [];
    let prev = 0;
    for (let i = 0; i < 5; i++) {
      prev = await tickAndReadSeq(page, prev);
      history.push(prev);
    }
    for (let i = 1; i < history.length; i++) {
      expect(history[i]).toBeGreaterThan(history[i - 1]);
    }
  });

  test('the seq counter is shared across connections to the same DO', async ({
    page,
  }, testInfo) => {
    // Two connections land on the same durable object, so they draw from one
    // sequence counter — seq numbers stay globally monotonic across both.
    const room = `seq-shared-${testInfo.testId}`;
    await page.goto('/sequence');
    await installRig(page);

    const a = await connect(page, { path: '/ws/sequence', username: 'alice', room });
    const b = await connect(page, { path: '/ws/sequence', username: 'bob', room });

    const seqs: number[] = [];
    for (let i = 0; i < 4; i++) {
      const conn = i % 2 === 0 ? a : b;
      const before = (await frames(page, conn)).filter((f) => f.event === 'tock').length;
      await send(page, conn, { event: 'tick', payload: {} });
      await page.waitForFunction(
        ([sid, cnt]) =>
          (window.__wskitFrames!(sid as string) ?? []).filter((f) => f.event === 'tock').length >
          (cnt as number),
        [conn, before],
      );
      const tocks = (await frames(page, conn)).filter(
        (f) => f.event === 'tock' && typeof f.__wskit?.seq === 'number',
      );
      seqs.push(tocks[tocks.length - 1]!.__wskit!.seq as number);
    }

    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });
});
