import { expect, test } from '@playwright/test';

test.describe('ctx-send', () => {
  test('sendTo delivers to connections tagged with the target tag', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-send?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    // onUpgrade tags this connection with its username, so sendTo(username, ...)
    // should deliver the message back to self.
    await page.getByTestId('send-to-self').click();
    await expect(page.getByTestId('messages')).toContainText('testuser:tagged');
  });

  test('sendToConnection with unknown ID reports delivered:false', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-send?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('send-to-unknown').click();
    await expect(page.getByTestId('delivery')).toHaveText('false');
    // No message should have been delivered anywhere visible to this client.
    await expect(page.getByTestId('messages')).toHaveText('');
  });

  test('ctx.close disconnects the client', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-send?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('server-close').click();
    await expect(page.getByTestId('status')).toHaveText('disconnected');
  });

  test('sendToConnection delivers to a known target connection', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await a.goto(`/ctx-send?room=${room}`);
    await b.goto(`/ctx-send?room=${room}`);
    await a.getByTestId('username').fill('alice');
    await b.getByTestId('username').fill('bob');
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected');
    await expect(b.getByTestId('status')).toHaveText('connected');

    // Bob asks for his own id.
    await b.getByTestId('who-am-i').click();
    await expect(b.getByTestId('connection-id')).not.toHaveText('');
    const bobId = (await b.getByTestId('connection-id').textContent()) ?? '';
    expect(bobId).toBeTruthy();

    // Alice targets Bob's id via the page's target-id input.
    await a.getByTestId('target-id').fill(bobId);
    await a.getByTestId('send-to-target').click();

    await expect(b.getByTestId('messages')).toContainText('alice:direct-to-target');
    await expect(a.getByTestId('delivery')).toHaveText('true');

    await ctxA.close();
    await ctxB.close();
  });

  test('sendTo fanout reaches every connection with the matching tag', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    // Both share the tag 'crew' via the same username.
    await a.goto(`/ctx-send?room=${room}`);
    await b.goto(`/ctx-send?room=${room}`);
    await a.getByTestId('username').fill('crew');
    await b.getByTestId('username').fill('crew');
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected');
    await expect(b.getByTestId('status')).toHaveText('connected');

    await a.getByTestId('send-to-self').click(); // sendTo('crew', 'tagged')

    await expect(a.getByTestId('messages')).toContainText('crew:tagged');
    await expect(b.getByTestId('messages')).toContainText('crew:tagged');

    await ctxA.close();
    await ctxB.close();
  });

  test('broadcast reaches every connection', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await a.goto(`/ctx-send?room=${room}`);
    await b.goto(`/ctx-send?room=${room}`);
    await a.getByTestId('username').fill('alice');
    await b.getByTestId('username').fill('bob');
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected');
    await expect(b.getByTestId('status')).toHaveText('connected');

    // broadcast-excl-hello uses { excludeSelf: false } — reaches everyone including sender.
    await a.getByTestId('broadcast-excl-hello').click();

    await expect(a.getByTestId('messages')).toContainText('alice:hello-excl');
    await expect(b.getByTestId('messages')).toContainText('alice:hello-excl');

    await ctxA.close();
    await ctxB.close();
  });

  test('ctx.close propagates the given code and reason on the wire', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto('/ctx-send');

    const closed = await page.evaluate(async (currentRoom) => {
      return new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${location.host}/ws/ctx-send?username=${encodeURIComponent('closer')}&room=${encodeURIComponent(currentRoom)}`;
        const ws = new WebSocket(url);
        ws.onopen = () => {
          ws.send(JSON.stringify({ event: 'do-server-close', payload: {} }));
        };
        ws.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason });
        ws.onerror = () => reject(new Error('ws failed'));
        setTimeout(() => reject(new Error('timeout')), 5_000);
      });
    }, room);

    expect(closed.code).toBe(4010);
    expect(closed.reason).toBe('server-close');
  });

  test('sendTo with an empty tag does not crash the connection', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-send?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('send-to-empty').click();

    // Positive signal: sendTo on the real username-tag still delivers after the no-op.
    await page.getByTestId('send-to-self').click();
    await expect(page.getByTestId('messages')).toContainText('testuser:tagged');
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('default broadcast excludes sender and reaches peer', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await a.goto(`/ctx-send?room=${room}`);
    await b.goto(`/ctx-send?room=${room}`);
    await a.getByTestId('username').fill('alice');
    await b.getByTestId('username').fill('bob');
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected');
    await expect(b.getByTestId('status')).toHaveText('connected');

    // a uses the default broadcast (excludes self) → only b receives 'alice:hello'.
    // Then b uses { excludeSelf: false } → both receive 'bob:hello-excl'.
    // Checking a's messages for 'bob:hello-excl' but not 'alice:hello' is
    // deterministic: if the default had looped back to a, it would arrive
    // before b's broadcast, so the absence check is reliable.
    await a.getByTestId('broadcast-hello').click();
    await expect(b.getByTestId('messages')).toContainText('alice:hello');

    await b.getByTestId('broadcast-excl-hello').click();
    await expect(a.getByTestId('messages')).toContainText('bob:hello-excl');
    await expect(a.getByTestId('messages')).not.toContainText('alice:hello');

    await ctxA.close();
    await ctxB.close();
  });
});
