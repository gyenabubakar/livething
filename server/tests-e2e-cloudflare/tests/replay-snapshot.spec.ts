import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
}

test.describe('replay-snapshot handler', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/replay-snapshot');
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('snapshot mode: only latest value per key replayed', async ({ page }) => {
    await page.getByTestId('update-doc-a-btn').click();
    await page.waitForTimeout(200);
    await page.getByTestId('update-doc-a2-btn').click();
    await page.waitForTimeout(200);

    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(500);

    const snapshots = await page.getByTestId('snapshots').textContent();
    const aEntries = snapshots!.split(' | ').filter((s) => s.startsWith('A:'));
    expect(aEntries).toHaveLength(1);
    expect(aEntries[0]).toBe('A:second-title');
  });

  test('best-effort durability: message replayable after async write', async ({ page }) => {
    await page.getByTestId('update-doc-b-btn').click();
    await page.waitForTimeout(200);

    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(500);

    const snapshots = await page.getByTestId('snapshots').textContent();
    expect(snapshots).toContain('B:doc-b-title');
  });

  test('retention pruning: maxMessages limits replayed snapshots', async ({ page }) => {
    await page.getByTestId('flood-btn').click();
    await page.waitForTimeout(500);

    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(500);

    const replayCount = Number(await page.getByTestId('replay-count').textContent());
    expect(replayCount).toBeLessThanOrEqual(5);
    expect(replayCount).toBeGreaterThan(0);
  });

  test('reduce: multiple increments merge into accumulated total', async ({ page }) => {
    await page.getByTestId('increment-counter-btn').click();
    await page.waitForTimeout(200);
    await page.getByTestId('increment-counter-btn2').click();
    await page.waitForTimeout(200);
    await page.getByTestId('increment-counter-btn').click();
    await page.waitForTimeout(200);

    await page.getByTestId('counter-replay-btn').click();
    await page.waitForTimeout(500);

    const snapshots = await page.getByTestId('counter-snapshots').textContent();
    const hitEntries = snapshots!.split(' | ').filter((s) => s.startsWith('hits:'));
    expect(hitEntries).toHaveLength(1);
    const total = Number(hitEntries[0]!.split(':')[1]);
    expect(total).toBe(13);
  });

  test('maxAgeMs: old messages pruned after expiry', async ({ page }) => {
    await page.getByTestId('age-test-btn').click();
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) return;
      ws.send(
        JSON.stringify({
          event: 'update-doc',
          payload: { docId: 'age-fresh', title: 'fresh-message' },
        }),
      );
    });
    await page.waitForTimeout(200);

    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(500);

    const snapshots = await page.getByTestId('snapshots').textContent();
    expect(snapshots).not.toContain('old-message');
    expect(snapshots).toContain('fresh-message');
  });
});
