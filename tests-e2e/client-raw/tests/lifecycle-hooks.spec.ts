import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('lifecycle-hooks', () => {
  async function openPage(page: Page, room: string, username = 'testuser') {
    await page.goto(`/lifecycle-hooks?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('onConnect fires and sends an event the connecting client can observe', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`, 'alice');
    await expect(page.getByTestId('connected-user')).toHaveText('alice');
  });

  test(
    'onDisconnect broadcasts to remaining peers when a client leaves',
    { tag: '@drop' },
    async ({ browser }, testInfo) => {
      const room = `test-${testInfo.testId}`;
      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();

      await openPage(a, room, 'alice');
      await openPage(b, room, 'bob');

      // Close bob's context entirely — equivalent to the client going away.
      // Alice's DO observes the ws close and fires onDisconnect.
      await ctxB.close();

      // Alice (peer) should observe bob leaving.
      await expect(a.getByTestId('disconnected-users')).toContainText('bob');

      await ctxA.close();
    },
  );

  test('onShutdown broadcasts to all clients before closing the DO', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await openPage(page, room, 'alice');

    const shutdownResponse = await page.request.post(`/ws/lifecycle-hooks/shutdown?room=${room}`);
    expect(shutdownResponse.status()).toBe(204);

    await expect(page.getByTestId('disconnected-users')).toContainText('server-shutdown');
    await expect(page.getByTestId('status')).toHaveText('disconnected');
  });

  test('onShutdown broadcasts user-left to every connected client', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}-shutdown-multi`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');

    const response = await a.request.post(`/ws/lifecycle-hooks/shutdown?room=${room}`);
    expect(response.status()).toBe(204);

    // Both clients must observe the server-shutdown broadcast before disconnecting.
    await expect(a.getByTestId('disconnected-users')).toContainText('server-shutdown');
    await expect(b.getByTestId('disconnected-users')).toContainText('server-shutdown');
    await expect(a.getByTestId('status')).toHaveText('disconnected');
    await expect(b.getByTestId('status')).toHaveText('disconnected');

    await ctxA.close();
    await ctxB.close();
  });

  test('onAuthenticate rejection (missing username) closes the socket with code 4001', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/lifecycle-hooks?room=${room}`);

    const result = await page.evaluate(async (currentRoom) => {
      return new Promise<string>((resolve) => {
        const ws = new WebSocket(
          `ws://${location.host}/ws/lifecycle-hooks?room=${encodeURIComponent(currentRoom)}`,
        );
        ws.onclose = (event) => resolve(`closed:${event.code}`);
        ws.onerror = () => {};
        setTimeout(() => resolve('timeout'), 5_000);
      });
    }, room);

    expect(result).toBe('closed:4001');
  });

  test('a graceful server shutdown closes connected sockets with GOING_AWAY (1001)', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}-shutdown-code`;
    await page.goto(`/lifecycle-hooks?room=${room}`);

    const result = await page.evaluate(async (currentRoom) => {
      const ws = new WebSocket(
        `ws://${location.host}/ws/lifecycle-hooks?username=alice&room=${encodeURIComponent(currentRoom)}`,
      );
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('open failed'));
      });
      const closed = new Promise<string>((resolve) => {
        ws.onclose = (event) => resolve(`closed:${event.code}`);
        setTimeout(() => resolve('timeout'), 5_000);
      });
      await fetch(`/ws/lifecycle-hooks/shutdown?room=${encodeURIComponent(currentRoom)}`, {
        method: 'POST',
      });

      return closed;
    }, room);

    expect(result).toBe('closed:1001');
  });

  test('HTTP upgrade rejection returns a 403 response (non-WS branch)', async ({
    request,
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/lifecycle-hooks?room=${room}`);
    const origin = new URL(page.url()).origin;

    // Rejected upgrades where code < 1000 fall through the HTTP branch and
    // return a plain HTTP status. Use the existing /ws/reject-http mount
    // (the lifecycle-hooks feature covers the WS-close branch above).
    const response = await request.fetch(`${origin}/ws/reject-http?room=${room}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    expect(response.status()).toBe(403);
    expect(response.headers()['content-type']).toContain('text/plain');
    await expect(response.text()).resolves.toBe('Forbidden HTTP upgrade');
  });

  test('requireUsername rejects missing username with close code 4001 across multiple mounts', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/lifecycle-hooks?room=${room}`);

    const mounts = [
      '/ws/lifecycle-hooks',
      '/ws/incoming',
      '/ws/channel-static',
      '/ws/ctx-send',
      '/ws/replay',
      '/ws/replay-snapshot',
      '/ws/plugins',
    ];

    for (const mount of mounts) {
      const result = await page.evaluate(
        async ({ mount, room }) => {
          return new Promise<string>((resolve) => {
            const ws = new WebSocket(
              `ws://${location.host}${mount}?room=${encodeURIComponent(room)}`,
            );
            ws.onclose = (ev) => resolve(`closed:${ev.code}`);
            ws.onerror = () => {};
            setTimeout(() => resolve('timeout'), 5_000);
          });
        },
        { mount, room },
      );
      expect(result, `mount ${mount}`).toBe('closed:4001');
    }
  });

  test('onError gets ValidationFailed when an incoming payload fails its schema', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-bad').click();
    await expect(page.getByTestId('validation-error')).toHaveText('bad-event');
  });

  test('onError fires when an error occurs inside a lifecycle hook', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('trigger-error').click();
    await expect(page.getByTestId('error-message')).toHaveText(/test-error/);
  });

  test('onShutdown fires even when no clients are connected', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const shutdownResponse = await page.request.post(`/ws/lifecycle-hooks/shutdown?room=${room}`);
    expect(shutdownResponse.status()).toBe(204);
  });

  test('onAuthenticate can attach meta and tags to connection', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await openPage(page, room, 'alice');
    await expect(page.getByTestId('auth-meta')).toHaveText('alice');
  });

  test('onConnect hook delivers connect-count event on client join', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`, 'alice');
    await expect(page.getByTestId('connect-count')).toHaveText(/2/);
  });

  test('async lifecycle hooks are awaited before proceeding', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`, 'alice');
    await expect(page.getByTestId('async-hook-complete')).toHaveText('yes');
  });

  test('onDisconnect ctx carries closeCode and closeReason from the wire close event', async ({
    browser,
  }, testInfo) => {
    // Pin F3: the WebSocket close code and reason from the adapter
    // (cf adapter forwards them on webSocketClose) thread through the
    // engine and land on the onDisconnect ctx. Alice closes with a
    // custom 4001/'kicked-by-admin' code; bob observes alice's leave
    // through the disconnect-close broadcast and the payload carries
    // the same code and reason — proving the values reached the
    // onDisconnect hook on the server.
    const room = `test-${testInfo.testId}-close-info`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');

    await a.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.close(4001, 'kicked-by-admin');
    });

    await expect(b.getByTestId('disconnect-close-entries')).toContainText(
      'alice:4001:kicked-by-admin',
    );

    await ctxA.close();
    await ctxB.close();
  });

  test('onDisconnect ctx carries closeCode 1000 for an explicit graceful close', async ({
    browser,
  }, testInfo) => {
    // Same path as the kick case but with an explicit 1000 close. The
    // server must observe code 1000 and an empty reason.
    const room = `test-${testInfo.testId}-graceful-close`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');

    await a.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.close(1000, '');
    });

    await expect(b.getByTestId('disconnect-close-entries')).toContainText('alice:1000:');

    await ctxA.close();
    await ctxB.close();
  });
});
