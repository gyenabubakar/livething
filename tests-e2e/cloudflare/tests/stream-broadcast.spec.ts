import { expect, test } from '@playwright/test';

test.describe('stream-broadcast', () => {
  test('broadcast stream reaches trigger connection and every peer', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await a.goto(`/stream-broadcast?room=${room}`);
    await b.goto(`/stream-broadcast?room=${room}`);
    await a.getByTestId('username').fill('alice');
    await b.getByTestId('username').fill('bob');
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected');
    await expect(b.getByTestId('status')).toHaveText('connected');

    // broadcast() fans each chunk to peers while the trigger still receives
    // its normal per-stream copy.
    await a.getByTestId('start-3').click();
    await expect(a.getByTestId('stream-end')).toHaveText('yes');
    await expect(a.getByTestId('indices')).toHaveText('0,1,2');
    await expect(b.getByTestId('indices')).toContainText('0');
    await expect(b.getByTestId('indices')).toContainText('1');
    await expect(b.getByTestId('indices')).toContainText('2');

    await ctxA.close();
    await ctxB.close();
  });

  test('trigger receives each chunk once while peers still receive the broadcast', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await a.goto(`/stream-broadcast?room=${room}`);
    await b.goto(`/stream-broadcast?room=${room}`);
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected');
    await expect(b.getByTestId('status')).toHaveText('connected');

    await a.getByTestId('start-3').click();
    await expect(a.getByTestId('stream-end')).toHaveText('yes');

    await expect(a.getByTestId('indices')).toHaveText('0,1,2');
    await expect(b.getByTestId('indices')).toHaveText('0,1,2');

    await ctxA.close();
    await ctxB.close();
  });
});
