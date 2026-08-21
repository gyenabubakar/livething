import { expect, test } from '@playwright/test';

test.describe('inbox boot reconciliation (real Durable Object)', () => {
  test('removes a stale receipt-only scope after a restart', async ({ page }, testInfo) => {
    const room = `inbox-reconcile-${testInfo.testId}`;
    await page.goto('/');

    const seed = await page.evaluate(async (currentRoom) => {
      const response = await fetch(
        `/ws/receipts/seed-stale?room=${encodeURIComponent(currentRoom)}`,
        {
          method: 'POST',
        },
      );
      return response.status;
    }, room);
    expect(seed).toBe(204);

    const before = await page.evaluate(async (currentRoom) => {
      const response = await fetch(
        `/ws/receipts/stale-count?room=${encodeURIComponent(currentRoom)}`,
      );
      return (await response.json()) as { count: number };
    }, room);
    expect(before.count).toBe(1);

    const restart = await page.evaluate(async (currentRoom) => {
      const response = await fetch(`/ws/receipts/restart?room=${encodeURIComponent(currentRoom)}`, {
        method: 'POST',
      });
      return response.status;
    }, room);
    expect(restart).toBe(204);

    const after = await page.evaluate(async (currentRoom) => {
      const response = await fetch(
        `/ws/receipts/stale-count?room=${encodeURIComponent(currentRoom)}`,
      );
      return (await response.json()) as { count: number };
    }, room);
    expect(after.count).toBe(0);
  });
});
