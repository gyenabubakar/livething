import { expect, test } from '@playwright/test';
import { connect, installRig, send, waitForFrame } from './_ws-rig.ts';

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

  test('protocol-shaped but undeclared event (__bogus__) returns a typed __error__ and keeps the connection alive', async ({
    page,
  }, testInfo) => {
    // '__bogus__' has the protocol-event shape (__x__), so the gateway routes
    // it to the protocol dispatcher, where it fails to match any known
    // IncomingProtocolFrame variant. The engine surfaces that as a typed
    // __error__ with code 'validation-failed' and returns — it never closes the
    // socket. Liveness is proven by a follow-up JSON ping → pong round-trip.
    await installRig(page);
    const room = `protocol-bogus-${testInfo.testId}`;
    const sock = await connect(page, { path: '/ws/protocol-pings', username: 'alice', room });

    await send(page, sock, { event: '__bogus__', payload: {} });
    const err = await waitForFrame(page, sock, {
      match: (f) => f.event === '__error__',
    });
    expect(err.payload.code).toBe('validation-failed');

    // Connection stays alive: a JSON ping still gets a JSON pong.
    await send(page, sock, { event: 'ping', payload: {} });
    const pong = await waitForFrame(page, sock, {
      match: (f) => f.event === 'pong',
    });
    expect(pong.event).toBe('pong');
  });
});
