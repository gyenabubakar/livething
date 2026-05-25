import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout: 10_000 });
}

test.describe('replay-snapshot handler', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    // Include retry count so each attempt uses a fresh DO (room) — otherwise
    // a retried test sees leftover state written by the prior failed attempt
    // and can't pass no matter how stable the logic is.
    const room = `test-${testInfo.testId}-r${testInfo.retry}`;
    await page.goto(`/replay-snapshot?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('burst-counter handler fires once and reports the sent count', async ({ page }) => {
    await page.getByTestId('burst-50-btn').click();
    await waitForText(page, 'burst-done-count', '1');
    await waitForText(page, 'burst-done-sent', '50');
  });

  test('snapshot mode: only latest value per key replayed', async ({ page }) => {
    const seqBefore = Number(await page.getByTestId('last-seq').textContent());
    await page.getByTestId('update-doc-a-btn').click();
    await page.getByTestId('update-doc-a2-btn').click();
    await expect(async () => {
      expect(Number(await page.getByTestId('last-seq').textContent())).toBeGreaterThanOrEqual(
        seqBefore + 2,
      );
    }).toPass({ timeout: 5_000 });
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
    const seqBefore = Number(await page.getByTestId('last-seq').textContent());
    await page.getByTestId('increment-counter-btn').click();
    await page.getByTestId('increment-counter-btn2').click();
    await page.getByTestId('increment-counter-btn').click();
    await expect(async () => {
      expect(Number(await page.getByTestId('last-seq').textContent())).toBeGreaterThanOrEqual(
        seqBefore + 3,
      );
    }).toPass({ timeout: 5_000 });
    await page.getByTestId('counter-replay-btn').click();
    await expect(async () => {
      const snapshots = await page.getByTestId('counter-snapshots').textContent();
      const hitEntries = snapshots!.split(' | ').filter((s) => s.startsWith('hits:'));
      expect(hitEntries).toHaveLength(1);
      const total = Number(hitEntries[0]!.split(':')[1]);
      expect(total).toBe(13);
    }).toPass({ timeout: 5_000 });
  });

  test('reduce-merge snapshot replays merged value with latest seq for since=N1-1', async ({
    page,
  }) => {
    // Increment once — snapshot row stored at seq=N1 with total=5.
    await page.getByTestId('increment-counter-btn').click(); // +5
    await expect(async () => {
      const seqText = await page.getByTestId('last-seq').textContent();
      expect(Number(seqText)).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });
    const firstSeq = Number(await page.getByTestId('last-seq').textContent());
    expect(firstSeq).toBeGreaterThan(0);

    // Increment again — reducer merges 5+3=8, snapshot row updated to seq=N2.
    await page.getByTestId('increment-counter-btn2').click(); // +3
    await expect(async () => {
      const seqText = await page.getByTestId('last-seq').textContent();
      expect(Number(seqText)).toBeGreaterThan(firstSeq);
    }).toPass({ timeout: 5_000 });
    const secondSeq = Number(await page.getByTestId('last-seq').textContent());
    expect(secondSeq).toBeGreaterThan(firstSeq);

    // Request __replay__ lastKnownSeq=firstSeq-1 (between original creation and
    // merge). The merged row should come back with seq=N2 and total=8 — proving
    // merging updates the snapshot's seq to the latest message's seq.
    const replayed = await page.evaluate(async (since) => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws!;
      const collected: {
        event: string;
        payload: Record<string, unknown>;
        __wskit?: Record<string, unknown>;
      }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string' && ev.data !== 'pong') {
          try {
            const parsed = JSON.parse(ev.data) as {
              event: string;
              payload: Record<string, unknown>;
              __wskit?: Record<string, unknown>;
            };
            collected.push(parsed);
          } catch {
            // ignore
          }
        }
        if (typeof original === 'function') original.call(ws, ev);
      };
      ws.send(
        JSON.stringify({ event: '__replay__', payload: { lastKnownSeq: since }, __wskit: {} }),
      );
      await new Promise((r) => setTimeout(r, 1500));
      return collected.filter((m) => m.event === 'counter-snapshot');
    }, firstSeq - 1);

    expect(replayed).toHaveLength(1);
    const merged = replayed[0]!;
    expect(merged.payload.total).toBe(8);
    expect(merged.__wskit?.seq).toBe(secondSeq);
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
    const seqAfterJoin = Number(await page.getByTestId('last-seq').textContent());
    await page.getByTestId('room-update-doc-a-btn').click();
    await page.getByTestId('room-update-doc-a2-btn').click();
    await expect(async () => {
      expect(Number(await page.getByTestId('last-seq').textContent())).toBeGreaterThanOrEqual(
        seqAfterJoin + 2,
      );
    }).toPass({ timeout: 5_000 });
    await page.getByTestId('room-replay-btn').click();

    await expect(async () => {
      const snapshots = await page.getByTestId('room-snapshots').textContent();
      const entries = snapshots!.split(' | ').filter((entry) => entry.startsWith('A:'));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toBe('A:room-second');
    }).toPass({ timeout: 5_000 });
  });
});
