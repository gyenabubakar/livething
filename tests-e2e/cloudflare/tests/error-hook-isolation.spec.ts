import { expect, test } from '@playwright/test';

test.describe('error-hook-isolation', () => {
  test('a throwing onError hook does not block the _error frame — request rejects with the original correlationId', async ({
    page,
  }, testInfo) => {
    const room = `iso-${testInfo.testId}`;
    await page.goto(`/error-hook-isolation?room=${room}`);
    await page.getByTestId('username').fill('user');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    // Send a raw `do-request` frame with our own correlation id and watch
    // for the matching `__error__` to come back. If the throwing onError
    // hook blocked the protocol send, the __error__ never arrives and the
    // page.waitForFunction call below times out.
    const errorFrame = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws!;
      const correlationId = 'cid-test-1';
      const received: {
        event: string;
        payload: Record<string, unknown>;
        __wskit?: Record<string, unknown>;
      }[] = [];
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return;
        received.push(JSON.parse(ev.data));
      });
      ws.send(
        JSON.stringify({
          event: 'do-request',
          payload: { text: 'hi' },
          __wskit: { correlationId },
        }),
      );
      // Wait up to 2s for the `__error__` carrying the same correlation id.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const match = received.find(
          (m) => m.event === '__error__' && m.__wskit?.correlationId === correlationId,
        );
        if (match) return match;
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    });

    expect(errorFrame).not.toBeNull();
    expect(errorFrame!.payload.code).toBe('internal-error');
    expect(errorFrame!.__wskit!.correlationId).toBe('cid-test-1');
  });
});
