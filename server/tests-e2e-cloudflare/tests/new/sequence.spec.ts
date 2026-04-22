import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function tickAndReadSeq(page: Page, prev: number): Promise<number> {
  await page.getByTestId('tick').click();
  await expect
    .poll(async () => Number((await page.getByTestId('last-seq').textContent()) || '0'))
    .toBeGreaterThan(prev);
  return Number((await page.getByTestId('last-seq').textContent()) || '0');
}

test.describe('sequence', () => {
  test('outgoing frames carry an incrementing _seq number', async ({ page }, testInfo) => {
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
});
