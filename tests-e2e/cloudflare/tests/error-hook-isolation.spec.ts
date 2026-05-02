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
    // for the matching `_error` to come back. If the throwing onError hook
    // blocked the protocol send, the _error never arrives and the
    // page.waitForFunction call below times out.
    const errorFrame = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws!;
      const correlationId = 'cid-test-1';
      const received: { event: string; payload: Record<string, unknown> }[] = [];
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return;
        received.push(JSON.parse(ev.data));
      });
      ws.send(
        JSON.stringify({
          event: 'do-request',
          payload: { text: 'hi', _correlationId: correlationId },
        }),
      );
      // Wait up to 2s for the `_error` carrying the same correlation id.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const match = received.find(
          (m) => m.event === '_error' && m.payload._correlationId === correlationId,
        );
        if (match) return match;
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    });

    expect(errorFrame).not.toBeNull();
    expect(errorFrame!.payload.code).toBe('internal-error');
    expect(errorFrame!.payload._correlationId).toBe('cid-test-1');
  });
});
