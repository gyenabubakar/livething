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

    // broadcast() fans each chunk to every connection INCLUDING the trigger.
    // Trigger receives each chunk twice (once via normal stream path, once
    // via broadcast fan-out), peer receives each once — use toContainText so
    // this test proves delivery, not exact multiplicity.
    await a.getByTestId('start-3').click();
    await expect(a.getByTestId('stream-end')).toHaveText('yes');
    await expect(a.getByTestId('indices')).toContainText('0');
    await expect(a.getByTestId('indices')).toContainText('1');
    await expect(a.getByTestId('indices')).toContainText('2');
    await expect(b.getByTestId('indices')).toContainText('0');
    await expect(b.getByTestId('indices')).toContainText('1');
    await expect(b.getByTestId('indices')).toContainText('2');

    await ctxA.close();
    await ctxB.close();
  });

  test('trigger receives each chunk twice (stream path + broadcast fan-out)', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const page = await browser.newPage();

    await page.goto(`/stream-broadcast?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('start-3').click();
    await expect(page.getByTestId('stream-end')).toHaveText('yes');

    // With broadcast:true, the trigger gets each chunk twice:
    //   - once from sendThroughPipeline (the normal per-client stream path, with _streamId)
    //   - once from broadcastToConnections fan-out (no _streamId, no excludeSelf)
    // This is current behavior. If excludeSelf:true is ever added, this test will fail
    // with '0,1,2' and the expected value should be updated accordingly.
    await expect(page.getByTestId('indices')).toHaveText('0,0,1,1,2,2');

    await page.close();
  });
});
