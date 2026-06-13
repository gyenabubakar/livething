import { expect, test } from '@playwright/test';

// keepalive is a LIVENESS check: the server pings, and a client that keeps
// answering (or sends anything) is kept open. Only a client that stops
// responding entirely is closed. The handler uses
// keepalive: { pingIntervalMs: 1000, idleTimeoutMs: 2000 }, so the keepalive
// ping fires at ~1s and the idle/close window is 2s.
test.describe('keepalive', () => {
  test('an unresponsive connection (no pong, no messages) is closed with 4004 after the timeout', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    // No ?autopong — the raw socket never answers the keepalive ping, so the
    // server sees a client that has gone away.
    await page.goto(`/keepalive?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    // Send nothing and never pong. The 2s close window elapses → closed.
    await expect(page.getByTestId('status')).toHaveText('disconnected', { timeout: 10_000 });
    await expect(page.getByTestId('close-code')).toHaveText('4004');
  });

  test('a quiet but responsive connection (pongs only, no app messages) stays open past the timeout', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    // ?autopong=1 makes the page answer the keepalive ping with "pong" — a live
    // client that simply has nothing to say. It must NOT be closed.
    await page.goto(`/keepalive?room=${room}&autopong=1`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    // Wait well past the 2s window without sending a single app message. The
    // automatic pongs keep the connection alive.
    await page.waitForTimeout(3_500);
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('app messages keep the connection alive across the timeout window', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    // No autopong — the only thing keeping this socket alive is the app
    // messages, proving an app frame resets the close window on its own.
    await page.goto(`/keepalive?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    // Window is 2s. Send an echo every 1.2s (gap < window) for >2× the window.
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(1_200);
      await page.getByTestId('send-echo').click();
    }

    await expect(page.getByTestId('status')).toHaveText('connected');
  });
});
