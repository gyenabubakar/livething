import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
}

test.describe('custom replay handler', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/replay-custom');
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('sends and receives notes', async ({ page }) => {
    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /testuser: custom replay note/);
  });

  test('custom replay returns stored notes', async ({ page }) => {
    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /custom replay note/);

    const beforeCount = (await page.getByTestId('notes').textContent())!.split(' | ').length;
    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(500);
    const afterCount = (await page.getByTestId('notes').textContent())!.split(' | ').length;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  test('channel-scoped custom replay returns channel messages', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');

    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /custom replay note/);

    await page.getByTestId('room-note-btn').click();
    await waitForText(page, 'room-notes', /channel replay note/);

    await page.getByTestId('room-replay-btn').click();
    await page.waitForTimeout(500);

    const roomReplayCount = Number(await page.getByTestId('room-replay-count').textContent());
    expect(roomReplayCount).toBeGreaterThan(0);
  });

  test('onAfterSend marks messages as confirmed', async ({ page }) => {
    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /custom replay note/);
    await page.waitForTimeout(200);

    await page.getByTestId('confirmed-btn').click();
    await waitForText(page, 'confirmed-result', /total:\d+,confirmed:\d+/);

    const result = await page.getByTestId('confirmed-result').textContent();
    const match = result!.match(/total:(\d+),confirmed:(\d+)/);
    expect(Number(match![1])).toBeGreaterThan(0);
    expect(Number(match![2])).toBeGreaterThan(0);
  });
});
