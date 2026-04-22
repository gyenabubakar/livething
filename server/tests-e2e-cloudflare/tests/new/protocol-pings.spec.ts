import { expect, test } from '@playwright/test';

test.describe('protocol pings', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/protocol-pings?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('raw text ping returns raw text pong', async ({ page }) => {
    await page.getByTestId('raw-ping').click();
    await expect(page.getByTestId('last-message')).toHaveText('pong');
  });

  test('JSON {event:ping} returns JSON {event:pong}', async ({ page }) => {
    await page.getByTestId('json-ping').click();
    await expect(page.getByTestId('last-message')).toHaveText(/"event":"pong"/);
  });

  test('invalid JSON message does not crash connection', async ({ page }) => {
    // Send invalid JSON; connection should stay alive
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: () => WebSocket | null }).__ws?.();
      if (ws) ws.send('{invalid json}');
    });

    // Brief wait for processing
    await page.waitForTimeout(100);

    // Connection should still be responsive
    await expect(page.getByTestId('status')).toHaveText('connected');

    // Can still ping successfully
    await page.getByTestId('raw-ping').click();
    await expect(page.getByTestId('last-message')).toHaveText('pong');
  });

  test('non-ping JSON without handler does not crash connection', async ({ page }) => {
    // Send JSON with unmapped event
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: () => WebSocket | null }).__ws?.();
      if (ws) ws.send(JSON.stringify({ event: 'unknown-event' }));
    });

    await page.waitForTimeout(100);

    // Connection should still be responsive
    await expect(page.getByTestId('status')).toHaveText('connected');

    // Can still ping successfully
    await page.getByTestId('raw-ping').click();
    await expect(page.getByTestId('last-message')).toHaveText('pong');
  });

  test('pings work without any incoming handler registered', async ({ page }) => {
    // The handler does not register any .on() handlers — only lifycycle
    // Pings are protocol-level and should work regardless
    await page.getByTestId('raw-ping').click();
    await expect(page.getByTestId('last-message')).toHaveText('pong');

    await page.getByTestId('json-ping').click();
    await expect(page.getByTestId('last-message')).toHaveText(/"event":"pong"/);
  });
});
