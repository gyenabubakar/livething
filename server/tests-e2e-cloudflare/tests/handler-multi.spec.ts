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

  test('chat: onUnsubscribe broadcasts user-code system "left the chat" message', async ({
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
    await page1.getByTestId('chat-join-btn').click();
    await waitForText(page1, 'chat-subscribed', 'subscribed');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');
    await page2.getByTestId('chat-join-btn').click();
    await waitForText(page2, 'chat-subscribed', 'subscribed');

    await page2.getByTestId('chat-leave-btn').click();
    await waitForText(page1, 'chat-messages', /system: user2 left the chat/, 15_000);

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

  test('chat members count updates exactly after kick, and kicked client is isolated', async ({
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
    await page1.getByTestId('chat-join-btn').click();
    await waitForText(page1, 'chat-subscribed', 'subscribed');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');
    await page2.getByTestId('chat-join-btn').click();
    await waitForText(page2, 'chat-subscribed', 'subscribed');

    await page1.getByTestId('get-members-btn').click();
    await waitForText(page1, 'channel-members-result', 'chat:2');

    await page1.evaluate(() => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({ event: 'kick-from-channel', payload: { channel: 'chat', tag: 'user2' } }),
      );
    });

    await waitForText(page2, 'kicked-result', /kicked:chat/, 10_000);

    await page1.getByTestId('get-members-btn').click();
    await waitForText(page1, 'channel-members-result', 'chat:1');

    await page2.evaluate(() => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'send-chat',
          payload: { text: 'after-kick', _channel: 'chat' },
        }),
      );
    });

    await page1.waitForTimeout(500);
    await expect(page1.getByTestId('chat-messages')).not.toContainText('user2: after-kick');

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

  test('sendTo fanout reaches every connection with the matching tag', async ({
    browser,
  }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    const page3 = await browser.newPage();
    await page1.goto(`/?room=${room}`);
    await page2.goto(`/?room=${room}`);
    await page3.goto(`/?room=${room}`);

    await page1.getByTestId('username-input').fill('user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');
    await page1.getByTestId('tag-self-btn').click();
    await waitForText(page1, 'tag-result', /vip/);

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');
    await page2.getByTestId('tag-self-btn').click();
    await waitForText(page2, 'tag-result', /vip/);

    await page3.getByTestId('username-input').fill('sender');
    await page3.getByTestId('connect-btn').click();
    await waitForText(page3, 'status', 'connected');

    await page3.evaluate(() => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'send-to-tag',
          payload: { tag: 'vip', text: 'fanout hello' },
        }),
      );
    });

    await waitForText(page1, 'tagged-message', /sender: fanout hello/);
    await waitForText(page2, 'tagged-message', /sender: fanout hello/);
    await expect(page3.getByTestId('tagged-message')).toHaveText('');

    await page1.close();
    await page2.close();
    await page3.close();
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

  test('top-level broadcast with excludeSelf skips sender and reaches peer', async ({
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

    await page1.getByTestId('broadcast-exclude-self-btn').click();
    await waitForText(page2, 'broadcast-result', /user1: top-level-broadcast/);
    await expect(page1.getByTestId('broadcast-result')).toHaveText('');

    await page1.close();
    await page2.close();
  });

  test('broadcastBinary reaches both clients', async ({ browser }, testInfo) => {
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

    await page1.getByTestId('broadcast-binary-all-btn').click();
    await waitForText(page1, 'binary-result', 'binary:6');
    await waitForText(page2, 'binary-result', 'binary:6');

    await page1.close();
    await page2.close();
  });

  test('dynamic channel: onSubscribe broadcasts system "entered" to existing members', async ({
    browser,
  }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto(`/?room=${room}`);
    await page2.goto(`/?room=${room}`);

    await page1.getByTestId('username-input').fill('u1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');
    await page1.getByTestId('room-join-btn').click();
    await waitForText(page1, 'room-subscribed', 'subscribed');

    await page2.getByTestId('username-input').fill('u2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');
    await page2.getByTestId('room-join-btn').click();
    await waitForText(page2, 'room-subscribed', 'subscribed');

    // page1 (existing member) should see the system "entered" broadcast for u2
    await waitForText(page1, 'room-messages', /system: u2 entered room:general/);

    await page2.getByTestId('disconnect-btn').click();
    await waitForText(page1, 'room-messages', /system: u2 left room:general/, 15_000);

    await page1.close();
    await page2.close();
  });

  test('kick reason string reaches kicked client exactly', async ({ browser }, testInfo) => {
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

    await waitForText(page2, 'kicked-result', /Kicked by admin/, 10_000);
    const kicked = await page2.getByTestId('kicked-result').textContent();
    expect(kicked).toContain('kicked:chat');
    expect(kicked).toContain('Kicked by admin');

    await page1.close();
    await page2.close();
  });

  test('cross-connection _streamCancel from non-owner does not stop the stream', async ({
    browser,
  }, testInfo) => {
    const room = `multi-${testInfo.testId}`;
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    const pageB = await ctx.newPage();
    await pageA.goto(`/?room=${room}`);
    await pageB.goto(`/?room=${room}`);

    type Frame = { event: string; payload: Record<string, unknown> };

    async function rawConnect(page: Page, username: string) {
      await page.evaluate(
        async ({ username, room }) => {
          const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const url = `${protocol}//${location.host}/ws?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`;
          const ws = new WebSocket(url);
          const frames: Frame[] = [];
          (window as unknown as { __raw: WebSocket }).__raw = ws;
          (window as unknown as { __frames: Frame[] }).__frames = frames;
          ws.onmessage = (ev) => {
            if (typeof ev.data !== 'string' || ev.data === 'pong') return;
            try {
              frames.push(JSON.parse(ev.data) as Frame);
            } catch {
              // ignore
            }
          };
          await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error('ws failed'));
          });
        },
        { username, room },
      );
    }

    await rawConnect(pageA, 'streamer');
    await rawConnect(pageB, 'attacker');

    // Use a long enough prompt with a 30ms delay between tokens so we have
    // plenty of time to interleave a cross-connection cancel.
    await pageA.evaluate(() => {
      const ws = (window as unknown as { __raw: WebSocket }).__raw;
      ws.send(
        JSON.stringify({
          event: 'stream-prompt',
          payload: {
            prompt: 'one two three four five six seven eight nine ten',
            delayMs: 30,
            _namespace: 'ai',
          },
        }),
      );
    });

    // Capture A's _streamId.
    const streamId = await pageA.evaluate(async () => {
      const start = Date.now();
      while (Date.now() - start < 5_000) {
        const frames = (window as unknown as { __frames: Frame[] }).__frames;
        const ok = frames.find((f) => f.event === '_streamOk');
        if (ok) return ok.payload._streamId as string;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('no _streamOk');
    });
    expect(streamId).toBeTruthy();

    // Wait until A has received at least 1 chunk so the stream is live.
    const baselineChunks = await pageA.evaluate(async () => {
      const start = Date.now();
      while (Date.now() - start < 5_000) {
        const frames = (window as unknown as { __frames: Frame[] }).__frames;
        const chunks = frames.filter((f) => f.event === 'stream-prompt');
        if (chunks.length >= 1) return chunks.length;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('no chunks');
    });

    // B sends a cross-connection cancel using A's streamId.
    await pageB.evaluate((sid) => {
      const ws = (window as unknown as { __raw: WebSocket }).__raw;
      ws.send(
        JSON.stringify({
          event: '_streamCancel',
          payload: { _namespace: 'ai', _streamId: sid },
        }),
      );
    }, streamId);

    // 'A' should keep producing chunks — wait for at least 2 more.
    await pageA.waitForFunction(
      (baseline) => {
        const frames = (window as unknown as { __frames: { event: string }[] }).__frames;
        const chunks = frames.filter((f) => f.event === 'stream-prompt');
        return chunks.length >= baseline + 2;
      },
      baselineChunks,
      { timeout: 10_000 },
    );

    await ctx.close();
  });

  test('broadcastBinary with excludeSelf skips the caller', async ({ browser }, testInfo) => {
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

    await page1.getByTestId('broadcast-binary-exclude-self-btn').click();
    await waitForText(page2, 'binary-result', 'binary:6');
    // Caller should stay empty.
    await expect(page1.getByTestId('binary-result')).toHaveText('');

    await page1.close();
    await page2.close();
  });
});
