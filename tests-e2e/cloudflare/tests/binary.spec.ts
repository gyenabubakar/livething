import { expect, test } from '@playwright/test';

test.describe('binary', () => {
  test('onBinary fires with the received byte count', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/binary?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('send-5').click();
    await expect(page.getByTestId('last-size')).toHaveText('5');
  });

  test('onBinary can access ctx.meta (username)', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/binary?room=${room}`);
    await page.getByTestId('username').fill('binuser');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('send-5').click();
    await expect(page.getByTestId('last-size')).toHaveText('5');
    await expect(page.getByTestId('meta-username')).toHaveText('binuser');
  });

  test('broadcastBinary reaches every connection', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await a.goto(`/binary?room=${room}`);
    await b.goto(`/binary?room=${room}`);
    await a.getByTestId('username').fill('user1');
    await b.getByTestId('username').fill('user2');
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected');
    await expect(b.getByTestId('status')).toHaveText('connected');

    await a.getByTestId('broadcast-all-6').click();
    await expect(a.getByTestId('last-size')).toHaveText('6');
    await expect(b.getByTestId('last-size')).toHaveText('6');

    await ctxA.close();
    await ctxB.close();
  });

  test('broadcastBinary with excludeSelf skips the caller', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await a.goto(`/binary?room=${room}`);
    await b.goto(`/binary?room=${room}`);
    await a.getByTestId('username').fill('user1');
    await b.getByTestId('username').fill('user2');
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected');
    await expect(b.getByTestId('status')).toHaveText('connected');

    // a excludes self with size 6 → only b should receive 6.
    // Then b broadcasts-all with size 8 → both receive 8.
    // Checking a's received-sizes for "8" but not "6" is deterministic:
    // if a's own excludeSelf had looped back, 6 would be in the list too.
    await a.getByTestId('broadcast-exclude-self-6').click();
    await expect(b.getByTestId('received-sizes')).toContainText('6');

    await b.getByTestId('broadcast-all-8').click();
    await expect(a.getByTestId('received-sizes')).toContainText('8');
    await expect(a.getByTestId('received-sizes')).not.toContainText('6');

    await ctxA.close();
    await ctxB.close();
  });

  test('sendBinary delivers binary data to self', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/binary?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    // Handler receives binary via onBinary, echoes via ctx.sendBinary()
    // which delivers the exact bytes back to the same connection
    await page.getByTestId('send-5').click();
    await expect(page.getByTestId('last-size')).toHaveText('5');
    await expect(page.getByTestId('received-sizes')).toContainText('5');
  });

  test('onBinary fires for each binary frame in sequence', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/binary?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('send-5').click();
    await expect(page.getByTestId('last-size')).toHaveText('5');

    await page.getByTestId('send-5').click();
    await expect(page.getByTestId('received-sizes')).toContainText('5,5');
  });

  test('a thrown onBinary hook routes through _error and onError instead of escaping', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/binary?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');

    // Send a poison binary frame whose first byte triggers a throw inside onBinary.
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');
      const buf = new Uint8Array([0xfe, 0x00, 0x00, 0x00]).buffer;
      ws.send(buf);
    });

    // Client receives _error → handler routed the throw through handleRuntimeError.
    await expect(page.getByTestId('last-error-code')).toHaveText('internal-error');
    // onError lifecycle hook also fires with the original message.
    await expect(page.getByTestId('observed-error-message')).toHaveText('poison binary frame');

    // Connection still healthy: a follow-up clean binary still echoes.
    await page.getByTestId('send-5').click();
    await expect(page.getByTestId('last-size')).toHaveText('5');
  });
});
