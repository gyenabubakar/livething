import { expect, test } from '@playwright/test';

test.describe('error-hook-isolation', () => {
  test('a throwing onError hook does not block __error__ with metadata.exchange.id', async ({
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
        metadata?: Record<string, Record<string, unknown>> | null;
      }[] = [];
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return;

        received.push(window.__livethingDecode(ev.data));
      });
      ws.send(
        window.__livethingEncode({
          event: 'do-request',
          payload: { text: 'hi' },
          metadata: { exchange: { id: correlationId } },
        }),
      );
      // Wait up to 2s for the `__error__` carrying the same correlation id.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const match = received.find(
          (m) => m.event === '__error__' && m.metadata?.exchange?.id === correlationId,
        );
        if (match) return match;

        await new Promise((r) => setTimeout(r, 25));
      }

      return null;
    });

    expect(errorFrame).not.toBeNull();
    expect(errorFrame!.payload.code).toBe('internal-error');
    expect(errorFrame!.metadata!.exchange?.id).toBe('cid-test-1');
  });
});
