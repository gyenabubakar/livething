import { expect, test } from '@playwright/test';

test.describe('errors-control-flow', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/errors-control-flow?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('force disconnect (Disconnect error) closes the connection', async ({ page }) => {
    await page.getByTestId('force-disconnect').click();
    await expect(page.getByTestId('status')).toHaveText('disconnected');
  });

  test('Defer: message retried after the delay eventually succeeds', async ({ page }) => {
    await page.getByTestId('defer-test').click();
    await expect(page.getByTestId('defer-result')).toHaveText('deferred-received');
  });

  test('Block in intercept: handler never runs, no reply leaks', async ({ page }) => {
    await page.getByTestId('block-test').click();
    // Follow up with a real echo to prove the connection + pipeline are alive.
    await page.getByTestId('do-echo').click();
    await expect(page.getByTestId('echo-result')).toHaveText('alive');
    await expect(page.getByTestId('block-reply')).toHaveText('');
  });

  test('manual ValidationFailed triggers onValidationError', async ({ page }) => {
    await page.getByTestId('manual-validation').click();
    await expect(page.getByTestId('validation-error')).toHaveText(
      'validation-error:manual-validation',
    );
  });

  test('DeferExhausted fires onError after retries exhaust', async ({ page }) => {
    await page.getByTestId('always-defer').click();
    await expect(page.getByTestId('defer-exhausted')).toContainText('always-defer:retries=3');
  });

  test('Disconnect(code, reason) closes the wire with the given code and reason', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}-raw`;

    const closed = await page.evaluate(async (currentRoom) => {
      return new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${location.host}/ws/errors-control-flow?username=${encodeURIComponent('disc')}&room=${encodeURIComponent(currentRoom)}`;
        const ws = new WebSocket(url);
        ws.onopen = () => {
          ws.send(JSON.stringify({ event: 'force-disconnect', payload: {} }));
        };
        ws.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason });
        ws.onerror = () => reject(new Error('ws failed'));
        setTimeout(() => reject(new Error('timeout')), 5_000);
      });
    }, room);

    expect(closed.code).toBe(4009);
    expect(closed.reason).toBe('force disconnect');
  });

  test('Disconnect thrown from inside an intercept closes the connection', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}-intercept`;

    const closed = await page.evaluate(async (currentRoom) => {
      return new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${location.host}/ws/errors-control-flow?username=${encodeURIComponent('tester')}&room=${encodeURIComponent(currentRoom)}`;
        const ws = new WebSocket(url);
        ws.onopen = () => {
          ws.send(JSON.stringify({ event: 'disconnect-intercept', payload: {} }));
        };
        ws.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason });
        ws.onerror = () => reject(new Error('ws failed'));
        setTimeout(() => reject(new Error('timeout')), 5_000);
      });
    }, room);

    expect(closed.code).toBe(4011);
    expect(closed.reason).toBe('intercepted disconnect');
  });

  test('chat channel: always-defer exhausts and fires onError inside the channel', async ({
    page,
  }) => {
    await page.getByTestId('subscribe-chat').click();
    await expect(page.getByTestId('chat-subscribed')).toHaveText('yes');
    await page.getByTestId('chat-always-defer').click();
    await expect(page.getByTestId('defer-exhausted')).toContainText('chat-always-defer:retries=');
  });

  test('Defer thrown inside a stream is treated as an internal error and sends _error with code internal-error', async ({
    page,
  }) => {
    await page.getByTestId('start-defer-stream').click();
    await expect(page.getByTestId('stream-error')).toContainText('internal-error:');
  });
});
