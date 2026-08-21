import { expect, test } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

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

  test('JSON {event:ping} is not answered — raw text is the only ping form', async ({ page }) => {
    // The server speaks only raw "ping"/"pong" (matches the documented wire
    // format and the Cloudflare hibernation auto-response). A JSON ping is
    // treated like any unknown frame: ignored, no pong.
    await page.getByTestId('json-ping').click();
    await page.waitForTimeout(200);
    await expect(page.getByTestId('last-message')).not.toHaveText(/pong/);

    // Raw ping still works.
    await page.getByTestId('raw-ping').click();
    await expect(page.getByTestId('last-message')).toHaveText('pong');
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
    // The handler registers no .on() handlers — only lifecycle. The raw ping is
    // protocol-level and works regardless.
    await page.getByTestId('raw-ping').click();
    await expect(page.getByTestId('last-message')).toHaveText('pong');
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

    // Connection stays alive: a second bogus frame is still processed and
    // produces a second typed __error__ (raw ping/pong isn't JSON, so it can't
    // be the liveness probe here on the JSON-frame rig).
    await send(page, sock, { event: '__bogus__', payload: {} });
    await expect
      .poll(async () => (await frames(page, sock)).filter((f) => f.event === '__error__').length)
      .toBe(2);
  });
});
