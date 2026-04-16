import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
}

test.describe('multi-client', () => {
  test('chat: second user sees _memberJoin', async ({ browser }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/?room=${room}`);
    await page2.goto(`/?room=${room}`);

    await page1.getByTestId('username-input').fill('user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');
    await page1.getByTestId('chat-join-btn').click();
    await waitForText(page1, 'chat-subscribed', 'subscribed');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');
    await page2.getByTestId('chat-join-btn').click();
    await waitForText(page2, 'chat-subscribed', 'subscribed');

    await waitForText(page2, 'member-joins', /chat:/);

    await page1.close();
    await page2.close();
  });

  test('chat: cross-client broadcast', async ({ browser }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/?room=${room}`);
    await page2.goto(`/?room=${room}`);

    await page1.getByTestId('username-input').fill('user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');
    await page1.getByTestId('chat-join-btn').click();
    await waitForText(page1, 'chat-subscribed', 'subscribed');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');
    await page2.getByTestId('chat-join-btn').click();
    await waitForText(page2, 'chat-subscribed', 'subscribed');

    await page1.getByTestId('chat-send-btn').click();
    await waitForText(page2, 'chat-messages', /user1: hi from e2e/);

    await page1.close();
    await page2.close();
  });

  test('chat: _memberLeave on disconnect', async ({ browser }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/?room=${room}`);
    await page2.goto(`/?room=${room}`);

    await page1.getByTestId('username-input').fill('user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');
    await page1.getByTestId('chat-join-btn').click();
    await waitForText(page1, 'chat-subscribed', 'subscribed');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');
    await page2.getByTestId('chat-join-btn').click();
    await waitForText(page2, 'chat-subscribed', 'subscribed');

    await page2.getByTestId('disconnect-btn').click();
    await waitForText(page1, 'member-leaves', /chat:/, 15_000);

    await page1.close();
    await page2.close();
  });

  test('chat: _memberLeave on leave button', async ({ browser }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/?room=${room}`);
    await page2.goto(`/?room=${room}`);

    await page1.getByTestId('username-input').fill('user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');
    await page1.getByTestId('chat-join-btn').click();
    await waitForText(page1, 'chat-subscribed', 'subscribed');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');
    await page2.getByTestId('chat-join-btn').click();
    await waitForText(page2, 'chat-subscribed', 'subscribed');

    await page2.getByTestId('chat-leave-btn').click();
    await waitForText(page1, 'member-leaves', /chat:/, 15_000);

    await page1.close();
    await page2.close();
  });

  test('chat: kick sends _kicked to target', async ({ browser }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/?room=${room}`);
    await page2.goto(`/?room=${room}`);

    await page1.getByTestId('username-input').fill('user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');
    await page1.getByTestId('chat-join-btn').click();
    await waitForText(page1, 'chat-subscribed', 'subscribed');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');
    await page2.getByTestId('chat-join-btn').click();
    await waitForText(page2, 'chat-subscribed', 'subscribed');

    await page1.evaluate(() => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({ event: 'kick-from-channel', payload: { channel: 'chat', tag: 'user2' } }),
      );
    });

    await waitForText(page2, 'kicked-result', /kicked:chat/, 10_000);

    await page1.close();
    await page2.close();
  });

  test('dynamic channel isolation: room:general vs room:vip', async ({ browser }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/?room=${room}`);
    await page2.goto(`/?room=${room}`);

    await page1.getByTestId('username-input').fill('user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');

    await page1.getByTestId('room-join-btn').click();
    await waitForText(page1, 'room-subscribed', 'subscribed');

    await page2.evaluate(() => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: '_subscribe',
          payload: { _channel: 'room:vip', _channelScope: 'rooms' },
        }),
      );
    });

    await page1.getByTestId('room-send-btn').click();
    await waitForText(page1, 'room-messages', /user1: hi from room/);

    const page2Messages = await page2.getByTestId('room-messages').textContent();
    expect(page2Messages).not.toContain('user1: hi from room');

    await page1.close();
    await page2.close();
  });

  test('sendToConnection delivers to target', async ({ browser }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/?room=${room}`);
    await page2.goto(`/?room=${room}`);

    await page1.getByTestId('username-input').fill('user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');

    await page1.getByTestId('conn-info-btn').click();
    await waitForText(page1, 'connection-info', /count:/);
    const page1ConnId = await page1.getByTestId('connection-id').textContent();
    expect(page1ConnId).toBeTruthy();

    await page2.evaluate((targetId) => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'send-to-connection',
          payload: { connectionId: targetId, text: 'hello direct' },
        }),
      );
    }, page1ConnId);

    await waitForText(page2, 'send-to-conn-status', 'delivered:true');
    await waitForText(page1, 'send-to-conn-result', /user2: hello direct/);

    await page1.close();
    await page2.close();
  });

  test('sendToConnection with stale ID does not crash', async ({ browser }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/?room=${room}`);
    await page2.goto(`/?room=${room}`);

    await page1.getByTestId('username-input').fill('user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');

    await page2.getByTestId('conn-info-btn').click();
    await waitForText(page2, 'connection-info', /count:/);
    const page2ConnId = await page2.getByTestId('connection-id').textContent();

    await page2.getByTestId('server-close-btn').click();
    await waitForText(page2, 'status', 'disconnected');

    await page1.evaluate((staleId) => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'send-to-connection',
          payload: { connectionId: staleId, text: 'hello ghost' },
        }),
      );
    }, page2ConnId);

    await waitForText(page1, 'send-to-conn-status', 'delivered:false');
    await page1.getByTestId('echo-btn').click();
    await waitForText(page1, 'echo-result', /hello world/);
    await expect(page1.getByTestId('status')).toHaveText('connected');

    await page1.close();
    await page2.close();
  });

  test('top-level broadcast reaches second client', async ({ browser }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/?room=${room}`);
    await page2.goto(`/?room=${room}`);

    await page1.getByTestId('username-input').fill('user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');

    await waitForText(page1, 'user-events', /joined: user2/);

    await page2.getByTestId('disconnect-btn').click();
    await waitForText(page1, 'user-events', /left: user2/, 15_000);

    await page1.close();
    await page2.close();
  });

  test('broadcast stream reaches trigger connection and second client', async ({
    browser,
  }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/?room=${room}`);
    await page2.goto(`/?room=${room}`);

    await page1.getByTestId('username-input').fill('user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');

    await page1.getByTestId('broadcast-stream-btn').click();
    await waitForText(page1, 'broadcast-stream-tokens', /hello/, 15_000);
    await waitForText(page2, 'broadcast-stream-tokens', /hello/, 15_000);

    await page1.close();
    await page2.close();
  });
});
