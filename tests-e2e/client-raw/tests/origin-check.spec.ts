import { expect, test } from '@playwright/test';

// The page is served on one port and the LiveThing server listens on another. A browser
// sends the page's Origin on every WebSocket handshake, so the server must refuse a socket
// opened straight to its own port, and accept one that arrives through the same-origin proxy.
const serverPort = Number(process.env.LIVETHING_E2E_SERVER_PORT ?? 8787);

function openSocket(url: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.onopen = () => {
      socket.close();
      resolve('open');
    };
    socket.onclose = (event) => resolve(`closed:${event.code}`);
  });
}

test.describe('Origin check', () => {
  test('refuses a socket from a page on another origin', async ({ page }, testInfo) => {
    await page.goto('/');
    const url = `ws://127.0.0.1:${serverPort}/ws/incoming?room=oc-${testInfo.testId}&username=alice`;

    await expect(page.evaluate(openSocket, url)).resolves.toBe('closed:1006');
  });

  test('accepts a socket from the same origin', async ({ page }, testInfo) => {
    await page.goto('/');
    const url = await page.evaluate(
      (room) => `ws://${location.host}/ws/incoming?room=${room}&username=alice`,
      `oc-${testInfo.testId}`,
    );

    await expect(page.evaluate(openSocket, url)).resolves.toBe('open');
  });
});
