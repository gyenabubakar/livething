import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
}

test.describe('replay-snapshot handler', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/replay-snapshot?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('snapshot mode: only latest value per key replayed', async ({ page }) => {
    await page.getByTestId('update-doc-a-btn').click();
    await page.getByTestId('update-doc-a2-btn').click();
    await page.getByTestId('replay-btn').click();
    await expect(async () => {
      const snapshots = await page.getByTestId('snapshots').textContent();
      const aEntries = snapshots!.split(' | ').filter((s) => s.startsWith('A:'));
      expect(aEntries).toHaveLength(1);
      expect(aEntries[0]).toBe('A:second-title');
    }).toPass({ timeout: 5_000 });
  });

  test('best-effort durability: message replayable after async write', async ({ page }) => {
    await page.getByTestId('update-doc-b-btn').click();
    await page.getByTestId('replay-btn').click();
    await expect(async () => {
      const snapshots = await page.getByTestId('snapshots').textContent();
      expect(snapshots).toContain('B:doc-b-title');
    }).toPass({ timeout: 5_000 });
  });

  test('retention pruning: maxMessages limits replayed snapshots', async ({ page }) => {
    await page.getByTestId('flood-btn').click();
    await expect(async () => {
      await page.getByTestId('replay-btn').click();
      await expect(page.getByTestId('replay-count')).not.toHaveText('0', { timeout: 500 });
      const replayCount = Number(await page.getByTestId('replay-count').textContent());
      expect(replayCount).toBeLessThanOrEqual(5);
    }).toPass({ timeout: 10_000 });
  });

  test('reduce: multiple increments merge into accumulated total', async ({ page }) => {
    await page.getByTestId('increment-counter-btn').click();
    await page.getByTestId('increment-counter-btn2').click();
    await page.getByTestId('increment-counter-btn').click();
    await page.getByTestId('counter-replay-btn').click();
    await expect(async () => {
      const snapshots = await page.getByTestId('counter-snapshots').textContent();
      const hitEntries = snapshots!.split(' | ').filter((s) => s.startsWith('hits:'));
      expect(hitEntries).toHaveLength(1);
      const total = Number(hitEntries[0]!.split(':')[1]);
      expect(total).toBe(13);
    }).toPass({ timeout: 5_000 });
  });

  test('reduce can delete a snapshot key', async ({ page }) => {
    await page.getByTestId('update-doc-a-btn').click();
    await page.getByTestId('delete-doc-a-btn').click();
    await page.getByTestId('replay-btn').click();

    await expect(async () => {
      const snapshots = await page.getByTestId('snapshots').textContent();
      expect(snapshots).not.toContain('A:first-title');
      expect(snapshots).not.toContain('A:second-title');
    }).toPass({ timeout: 5_000 });
  });

  test('maxAgeMs: old messages pruned after expiry', async ({ page }) => {
    await page.getByTestId('age-test-btn').click();
    await page.waitForTimeout(1200);
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
    await page.getByTestId('replay-btn').click();
    await expect(async () => {
      const snapshots = await page.getByTestId('snapshots').textContent();
      expect(snapshots).not.toContain('old-message');
      expect(snapshots).toContain('fresh-message');
    }).toPass({ timeout: 5_000 });
  });

  test('channel snapshot replay keeps only the latest value per key', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');
    await page.getByTestId('room-update-doc-a-btn').click();
    await page.getByTestId('room-update-doc-a2-btn').click();
    await page.getByTestId('room-replay-btn').click();

    await expect(async () => {
      const snapshots = await page.getByTestId('room-snapshots').textContent();
      const entries = snapshots!.split(' | ').filter((entry) => entry.startsWith('A:'));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toBe('A:room-second');
    }).toPass({ timeout: 5_000 });
  });
});
