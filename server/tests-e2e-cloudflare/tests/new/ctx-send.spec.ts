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

    await a.getByTestId('broadcast-hello').click();

    await expect(a.getByTestId('messages')).toContainText('alice:hello');
    await expect(b.getByTestId('messages')).toContainText('alice:hello');

    await ctxA.close();
    await ctxB.close();
  });

  test('broadcast with excludeSelf skips sender and reaches peer', async ({
    browser,
  }, testInfo) => {
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

    // a excludes self with 'hello-excl' → only b receives.
    // Then b broadcasts-all with 'hello-all' → both receive.
    // Checking a's messages for 'bob:hello-all' but not 'alice:hello-excl'
    // is deterministic: if a's own excludeSelf had looped back, it would
    // land in a's message list before b's broadcast does.
    await a.getByTestId('broadcast-excl-hello').click();
    await expect(b.getByTestId('messages')).toContainText('alice:hello-excl');

    await b.getByTestId('broadcast-hello').click();
    await expect(a.getByTestId('messages')).toContainText('bob:hello');
    await expect(a.getByTestId('messages')).not.toContainText('alice:hello-excl');

    await ctxA.close();
    await ctxB.close();
  });
});
