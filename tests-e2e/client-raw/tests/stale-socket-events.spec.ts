import { expect, test } from '@playwright/test';

interface SocketCase {
  connectButton: string;
  disconnectButton: string;
  path: string;
  staleEvent: 'close' | 'error';
}

const cases: SocketCase[] = [
  {
    path: '/replay?room=stale-close-replay',
    connectButton: 'connect-btn',
    disconnectButton: 'disconnect-btn',
    staleEvent: 'close',
  },
  {
    path: '/replay?room=stale-error-replay',
    connectButton: 'connect-btn',
    disconnectButton: 'disconnect-btn',
    staleEvent: 'error',
  },
  {
    path: '/stream-durable?room=stale-close-stream',
    connectButton: 'connect',
    disconnectButton: 'drop-socket',
    staleEvent: 'close',
  },
];

for (const socketCase of cases) {
  test(`a stale ${socketCase.staleEvent} event cannot clear the replacement socket on ${socketCase.path}`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const sockets: Array<{
        onclose: ((event: Event) => void) | null;
        onerror: ((event: Event) => void) | null;
        onopen: ((event: Event) => void) | null;
        url: string;
      }> = [];

      class ControlledWebSocket {
        onclose: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onopen: ((event: Event) => void) | null = null;

        constructor(readonly url: string) {
          sockets.push(this);
        }

        close() {}

        send(_data: string) {}
      }

      Object.defineProperty(window, 'WebSocket', { value: ControlledWebSocket });
      Object.assign(window, { __controlledSockets: sockets });
    });

    await page.goto(socketCase.path);
    await page.getByTestId(socketCase.connectButton).click();
    await page.evaluate(() => {
      const sockets = (
        window as unknown as {
          __controlledSockets: Array<{
            onopen: ((event: Event) => void) | null;
            url: string;
          }>;
        }
      ).__controlledSockets;
      sockets.find((socket) => socket.url.includes('/ws/'))!.onopen?.(new Event('open'));
    });
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId(socketCase.disconnectButton).click();
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId(socketCase.connectButton).click();
    await page.evaluate(() => {
      const sockets = (
        window as unknown as {
          __controlledSockets: Array<{
            onopen: ((event: Event) => void) | null;
            url: string;
          }>;
        }
      ).__controlledSockets;
      sockets.filter((socket) => socket.url.includes('/ws/'))[1]!.onopen?.(new Event('open'));
    });
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.evaluate((staleEvent) => {
      const sockets = (
        window as unknown as {
          __controlledSockets: Array<{
            onclose: ((event: Event) => void) | null;
            onerror: ((event: Event) => void) | null;
            url: string;
          }>;
        }
      ).__controlledSockets;
      const staleSocket = sockets.find((socket) => socket.url.includes('/ws/'))!;
      if (staleEvent === 'close') staleSocket.onclose?.(new Event('close'));
      else staleSocket.onerror?.(new Event('error'));
    }, socketCase.staleEvent);
    await expect(page.getByTestId('status')).toHaveText('connected');
  });
}
