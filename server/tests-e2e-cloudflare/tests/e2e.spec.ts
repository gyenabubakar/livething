import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
}

// ═══════════════════════════════════════════════════════════════
// Main Handler — /ws
// ═══════════════════════════════════════════════════════════════

test.describe('main handler', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  // --- Connection lifecycle ---

  test('connects and disconnects', async ({ page }) => {
    await expect(page.getByTestId('status')).toHaveText('connected');
    await page.getByTestId('server-close-btn').click();
    await waitForText(page, 'status', 'disconnected', 15_000);
  });

  test('lifecycle: user-joined on connect', async ({ page }) => {
    await waitForText(page, 'user-events', /joined: testuser/);
  });

  // --- Echo + Ack ---

  test('echo with ack', async ({ page }) => {
    await page.getByTestId('echo-btn').click();
    await waitForText(page, 'echo-result', /testuser: hello world/);
    await waitForText(page, 'ack-result', 'acked');
  });

  test('sequence numbers increment', async ({ page }) => {
    await page.getByTestId('echo-btn').click();
    await waitForText(page, 'echo-result', /hello world/);
    const seq = await page.getByTestId('last-seq').textContent();
    expect(Number(seq)).toBeGreaterThan(0);
  });

  test('post-validation intercept rewrites payload', async ({ page }) => {
    await page.getByTestId('echo-rewrite-btn').click();
    await waitForText(page, 'echo-result', /testuser: rewritten-by-intercept/);
  });

  // --- Errors ---

  test('triggers not-found error', async ({ page }) => {
    await page.getByTestId('error-notfound-btn').click();
    await waitForText(page, 'error-result', /not-found/);
  });

  test('triggers forbidden error', async ({ page }) => {
    await page.getByTestId('error-forbidden-btn').click();
    await waitForText(page, 'error-result', /forbidden/);
  });

  // --- Request-response ---

  test('request-response: get-time', async ({ page }) => {
    await page.getByTestId('request-time-btn').click();
    await waitForText(page, 'time-result', /epoch:/);
  });

  // --- Chat channel ---

  test('chat channel: subscribe, send, receive', async ({ page }) => {
    await page.getByTestId('chat-join-btn').click();
    await waitForText(page, 'chat-subscribed', 'subscribed');
    await page.getByTestId('chat-send-btn').click();
    await waitForText(page, 'chat-messages', /testuser: hi from e2e/);
  });

  test('chat channel: join broadcasts system message', async ({ page }) => {
    await page.getByTestId('chat-join-btn').click();
    await waitForText(page, 'chat-messages', /testuser joined the chat/);
  });

  // --- Dynamic room channel ---

  test('dynamic channel: subscribe to room:general', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');
  });

  test('dynamic channel: send and receive in room', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');
    await page.getByTestId('room-send-btn').click();
    await waitForText(page, 'room-messages', /testuser: hi from room/);
  });

  // --- AI namespace ---

  test('ai namespace: send and receive response', async ({ page }) => {
    await page.getByTestId('ai-send-btn').click();
    await waitForText(page, 'ai-response', /Re: "hello AI"/);
  });

  test('ai namespace: request model info', async ({ page }) => {
    await page.getByTestId('ai-model-btn').click();
    await waitForText(page, 'ai-model-result', /fake-gpt-4/);
  });

  test('ai namespace: stream tokens', async ({ page }) => {
    await page.getByTestId('ai-stream-btn').click();
    await waitForText(page, 'ai-stream-done', 'stream-done', 15_000);
    const tokens = await page.getByTestId('ai-stream-tokens').textContent();
    expect(tokens).toContain('Re: "tell me a story"');
    expect(tokens).toContain('quick brown fox');
  });

  test('ai namespace: stream with nudge pause', async ({ page }) => {
    await page.getByTestId('ai-nudge-stream-btn').click();
    await page.waitForTimeout(300);
    await page.getByTestId('ai-nudge-pause-btn').click();
    await waitForText(page, 'ai-nudge-stream-done', 'nudge-stream-done', 10_000);
    const tokens = await page.getByTestId('ai-nudge-stream-tokens').textContent();
    expect(tokens!.length).toBeGreaterThan(0);
    expect(tokens!.length).toBeLessThan(500);
  });

  test('ai namespace: stream error', async ({ page }) => {
    await page.getByTestId('ai-stream-error-btn').click();
    await waitForText(page, 'ai-stream-error-result', /stream-error:not-found/);
  });

  // --- Scheduled tasks ---

  test('scheduled task fires after delay', async ({ page }) => {
    await page.getByTestId('schedule-btn').click();
    await waitForText(page, 'scheduled-result', /Cleaned \d+ items/, 15_000);
  });

  test('cancel scheduled task', async ({ page }) => {
    await page.getByTestId('cancel-cleanup-btn').click();
    await waitForText(page, 'cancel-result', 'cancelled');
  });

  // --- Storage ---

  test('sql: save and retrieve notes', async ({ page }) => {
    await page.getByTestId('save-note-btn').click();
    await waitForText(page, 'notes-list', /Test Note/);
  });

  test('kv: set and get value', async ({ page }) => {
    await page.getByTestId('kv-set-btn').click();
    await waitForText(page, 'kv-result', /test-key.*test-value/);
    await page.getByTestId('kv-get-btn').click();
    await waitForText(page, 'kv-result', /test-key.*test-value/);
  });

  // --- Connection management ---

  test('get connection info', async ({ page }) => {
    await page.getByTestId('conn-info-btn').click();
    await waitForText(page, 'connection-info', /count:\d+/);
  });

  test('tag and untag self', async ({ page }) => {
    await page.getByTestId('tag-self-btn').click();
    await waitForText(page, 'tag-result', /vip/);
    await page.getByTestId('untag-self-btn').click();
    await waitForText(page, 'tag-result', /^(?!.*vip)/);
  });

  // --- Binary ---

  test('binary echo', async ({ page }) => {
    await page.getByTestId('binary-send-btn').click();
    await waitForText(page, 'binary-result', /(binary|echoed):5/);
  });

  test('sendTo tag delivers message', async ({ page }) => {
    await page.getByTestId('send-to-tag-btn').click();
    await waitForText(page, 'tagged-message', /testuser: tagged hello/);
  });

  // --- Disconnect tests (placed last as they cause "send after close" noise) ---

  test('server close disconnects client', async ({ page }) => {
    await page.getByTestId('server-close-btn').click();
    await waitForText(page, 'status', 'disconnected', 10_000);
  });

  test('force disconnect (Disconnect error)', async ({ page }) => {
    await page.getByTestId('force-disconnect-btn').click();
    await waitForText(page, 'status', 'disconnected', 10_000);
  });

  // --- Validation / Defer / Block / Skip ---

  test('validation error fires onValidationError', async ({ page }) => {
    await page.getByTestId('validation-error-btn').click();
    await waitForText(page, 'validation-error-result', /validation-error:echo/);
  });

  test('defer: message retried after delay', async ({ page }) => {
    await page.getByTestId('defer-btn').click();
    await waitForText(page, 'defer-result', 'deferred-received', 15_000);
  });

  test('block: handler never runs, no block-reply received', async ({ page }) => {
    await page.getByTestId('block-btn').click();
    await page.waitForTimeout(500);
    const reply = await page.getByTestId('block-reply').textContent();
    expect(reply).toBe('');
  });

  test('skip: message passes through to handler', async ({ page }) => {
    await page.getByTestId('skip-btn').click();
    await waitForText(page, 'skip-reply', /leaked:true/);
  });

  test('manual ValidationFailed triggers onValidationError', async ({ page }) => {
    await page.getByTestId('manual-validation-btn').click();
    await waitForText(page, 'validation-error-result', /validation-error:manual-validation-test/);
  });

  test('DeferExhausted fires onError after retries exhaust', async ({ page }) => {
    await page.getByTestId('always-defer-btn').click();
    await waitForText(page, 'defer-exhausted-result', /always-defer:retries=/, 15_000);
  });

  // --- Channel members + subscribe rejection ---

  test('channel members count after join', async ({ page }) => {
    await page.getByTestId('chat-join-btn').click();
    await waitForText(page, 'chat-subscribed', 'subscribed');
    await page.getByTestId('get-members-btn').click();
    await waitForText(page, 'channel-members-result', /chat:\d+/);
  });

  // --- Connection API coverage ---

  test('getConnectionsByTag returns self', async ({ page }) => {
    await page.getByTestId('get-connections-by-tag-btn').click();
    await waitForText(page, 'connections-by-tag-result', /testuser:\d+/);
  });

  test('quality info returns values', async ({ page }) => {
    await page.getByTestId('get-quality-btn').click();
    await waitForText(page, 'quality-result', /buffered:\d+/);
  });

  // --- Storage: get-notes retrieval ---

  test('sql: save then get notes separately', async ({ page }) => {
    await page.getByTestId('save-note-btn').click();
    await waitForText(page, 'notes-list', /Test Note/);
    await page.getByTestId('get-notes-btn').click();
    await waitForText(page, 'notes-list', /Test Note/);
  });

  // --- Stream speed-up nudge ---

  test('ai namespace: stream speed-up nudge', async ({ page }) => {
    await page.getByTestId('ai-nudge-stream-btn').click();
    await page.waitForTimeout(200);
    await page.getByTestId('ai-speed-up-btn').click();
    await waitForText(page, 'ai-nudge-stream-done', 'nudge-stream-done', 15_000);
    const tokens = await page.getByTestId('ai-nudge-stream-tokens').textContent();
    expect(tokens!.length).toBeGreaterThan(0);
  });

  test('ai namespace: _streamOk received before chunks', async ({ page }) => {
    await page.getByTestId('ai-stream-btn').click();
    await waitForText(page, 'stream-ok-received', 'stream-ok');
    await waitForText(page, 'ai-stream-done', 'stream-done', 15_000);
  });

  test('ai namespace: pre-intercept blocks message', async ({ page }) => {
    await page.getByTestId('ai-blocked-btn').click();
    await page.waitForTimeout(500);
    const reply = await page.getByTestId('ai-blocked-reply').textContent();
    expect(reply).toBe('');
  });

  // --- Scheduled every ---

  test('scheduled every: heartbeat fires repeatedly', async ({ page }) => {
    await page.getByTestId('start-heartbeat-btn').click();
    await page.waitForTimeout(6000);
    const count = Number(await page.getByTestId('heartbeat-count').textContent());
    expect(count).toBeGreaterThanOrEqual(2);
  });

  // --- Scheduled retry with custom backoff ---

  test('scheduled retry: flaky task succeeds after retries', async ({ page }) => {
    await page.getByTestId('trigger-flaky-btn').click();
    await waitForText(page, 'flaky-task-result', /attempts:/, 10_000);
    const result = await page.getByTestId('flaky-task-result').textContent();
    expect(result).toMatch(/attempts:[3-9]/);
  });

  test('scheduled dead-letter: always-fail task lands in DLQ', async ({ page }) => {
    await page.getByTestId('trigger-always-fail-btn').click();
    await page.waitForTimeout(3000);
    await page.getByTestId('query-dead-letter-btn').click();
    await waitForText(page, 'dead-letter-result', /always-fail-task:attempts=/, 10_000);
    const result = await page.getByTestId('dead-letter-result').textContent();
    expect(result).toContain('permanent failure');
  });

  // --- Channel post-intercept ---

  test('channel post-intercept rewrites payload', async ({ page }) => {
    await page.getByTestId('chat-join-btn').click();
    await waitForText(page, 'chat-subscribed', 'subscribed');
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'send-chat',
          payload: { text: 'intercept-channel-test', _channel: 'chat' },
        }),
      );
    });
    await waitForText(page, 'chat-messages', /channel-intercepted/);
  });

  // --- Channel request ---

  test('channel request: get-chat-info returns channel name', async ({ page }) => {
    await page.getByTestId('chat-join-btn').click();
    await waitForText(page, 'chat-subscribed', 'subscribed');
    await page.getByTestId('chat-info-btn').click();
    await waitForText(page, 'chat-info-result', /chat:members=/);
  });

  // --- Channel stream ---

  test('chat channel: stream tokens inside channel', async ({ page }) => {
    await page.getByTestId('chat-join-btn').click();
    await waitForText(page, 'chat-subscribed', 'subscribed');
    await page.getByTestId('chat-stream-btn').click();
    await waitForText(page, 'chat-stream-done', 'chat-stream-done', 15_000);
    const tokens = await page.getByTestId('chat-stream-tokens').textContent();
    expect(tokens).toContain('hello');
    expect(tokens).toContain('channel');
    expect(tokens).toContain('stream');
  });

  // --- Scheduled: schedule then immediately cancel ---

  test('schedule then immediately cancel (cancel before fire)', async ({ page }) => {
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.send(JSON.stringify({ event: 'schedule-cleanup', payload: { delaySec: 10 } }));
    });
    await page.waitForTimeout(200);
    await page.getByTestId('cancel-cleanup-btn').click();
    await waitForText(page, 'cancel-result', 'cancelled');
    await page.waitForTimeout(2000);
    const result = await page.getByTestId('scheduled-result').textContent();
    expect(result).toBe('');
  });

  // --- Stream cancel ---

  test('stream cancel: client cancels mid-stream', async ({ page }) => {
    await page.getByTestId('ai-stream-btn').click();
    await page.waitForTimeout(200);
    await page.getByTestId('ai-stream-cancel-btn').click();
    await page.waitForTimeout(500);
    const tokens = await page.getByTestId('ai-stream-tokens').textContent();
    expect(tokens!.length).toBeGreaterThan(0);
    expect(tokens!.length).toBeLessThan(300);
  });

  // --- namespace-scoped post-intercept ---

  test('ai namespace: post-intercept rewrites payload', async ({ page }) => {
    await page.getByTestId('ai-post-intercept-btn').click();
    await waitForText(page, 'ai-post-intercept-result', /namespace-post-intercepted/);
  });

  // --- dedup e2e verification ---

  test('dedup: outgoing messages have unique _messageId', async ({ page }) => {
    await page.getByTestId('echo-btn').click();
    await waitForText(page, 'echo-result', /hello world/);
    await page.getByTestId('echo-btn').click();
    await page.waitForTimeout(500);
    const ids = await page.getByTestId('received-message-ids').textContent();
    const idList = ids!.split(',').filter(Boolean);
    expect(idList.length).toBeGreaterThanOrEqual(2);
    expect(new Set(idList).size).toBe(idList.length);
  });

  // --- stream cancel sends cancel ack ---

  test('stream cancel sends cancel ack', async ({ page }) => {
    await page.getByTestId('ai-nudge-stream-btn').click();
    await page.waitForTimeout(300);
    await page.getByTestId('ai-stream-cancel-btn').click();
    await waitForText(page, 'stream-cancel-result', 'cancelled');
  });

  // --- multiple nudge types in single stream ---

  test('ai namespace: compose speed-up then pause in single stream', async ({ page }) => {
    await page.getByTestId('ai-nudge-stream-btn').click();
    await page.waitForTimeout(200);
    await page.getByTestId('ai-speed-up-btn').click();
    await page.waitForTimeout(300);
    await page.getByTestId('ai-nudge-pause-btn').click();
    await waitForText(page, 'ai-nudge-stream-done', 'nudge-stream-done', 10_000);
    const tokens = await page.getByTestId('ai-nudge-stream-tokens').textContent();
    expect(tokens!.length).toBeGreaterThan(0);
  });

  // --- _replay on handler without replay ---

  test('_replay on handler without replay is handled gracefully', async ({ page }) => {
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.send(JSON.stringify({ event: '_replay', payload: { since: 0 } }));
    });
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('status')).toHaveText('connected');
    await page.getByTestId('echo-btn').click();
    await waitForText(page, 'echo-result', /hello world/);
  });

  // --- sendTo with empty tag ---

  test('sendTo with empty tag does not crash', async ({ page }) => {
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'send-to-tag',
          payload: { tag: 'nonexistent-tag-xyz', text: 'ghost message' },
        }),
      );
    });
    await page.waitForTimeout(500);
    await expect(page.getByTestId('status')).toHaveText('connected');
    await page.getByTestId('echo-btn').click();
    await waitForText(page, 'echo-result', /hello world/);
  });
});

// ═══════════════════════════════════════════════════════════════
// Subscribe Rejection + Upgrade Rejection
// ═══════════════════════════════════════════════════════════════

test.describe('subscribe rejection', () => {
  test('chat rejects blocked-user (no _subscribeOk)', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('username-input').fill('blocked-user');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('chat-join-btn').click();
    await page.waitForTimeout(1500);
    const subscribed = await page.getByTestId('chat-subscribed').textContent();
    expect(subscribed).toBe('');
  });

  test('dynamic room rejects banned-user (no _subscribeOk)', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('username-input').fill('banned-user');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('room-join-btn').click();
    await page.waitForTimeout(1500);
    const subscribed = await page.getByTestId('room-subscribed').textContent();
    expect(subscribed).toBe('');
  });

  test('chat rejects blocked-user with error payload', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('username-input').fill('blocked-user');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('chat-join-btn').click();
    await waitForText(page, 'subscribe-error', /chat:/);
  });

  test('upgrade rejection: no username closes connection', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      return new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws`);
        ws.onclose = (e) => resolve(`closed:${e.code}`);
        ws.onerror = () => {
          // onerror fires before onclose in some browsers, wait for onclose
        };
        setTimeout(() => resolve('timeout'), 5000);
      });
    });
    expect(result).toBe('closed:4001');
  });
});

// ═══════════════════════════════════════════════════════════════
// Multi-Client Tests
// ═══════════════════════════════════════════════════════════════

test.describe('multi-client', () => {
  test('chat: second user sees _memberJoin', async ({ browser }) => {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto('/');
    await page2.goto('/');

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

  test('chat: cross-client broadcast', async ({ browser }) => {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto('/');
    await page2.goto('/');

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

  test('chat: _memberLeave on disconnect', async ({ browser }) => {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto('/');
    await page2.goto('/');

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

  test('chat: _memberLeave on leave button', async ({ browser }) => {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto('/');
    await page2.goto('/');

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

  test('chat: kick sends _kicked to target', async ({ browser }) => {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto('/');
    await page2.goto('/');

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

  test('dynamic channel isolation: room:general vs room:vip', async ({ browser }) => {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto('/');
    await page2.goto('/');

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
    await page2.waitForTimeout(500);

    await page1.getByTestId('room-send-btn').click();
    await waitForText(page1, 'room-messages', /user1: hi from room/);

    await page2.waitForTimeout(1000);
    const page2Messages = await page2.getByTestId('room-messages').textContent();
    expect(page2Messages).not.toContain('user1: hi from room');

    await page1.close();
    await page2.close();
  });

  test('sendToConnection delivers to target', async ({ browser }) => {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto('/');
    await page2.goto('/');

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

    await waitForText(page1, 'send-to-conn-result', /user2: hello direct/);

    await page1.close();
    await page2.close();
  });

  test('sendToConnection with stale ID does not crash', async ({ browser }) => {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto('/');
    await page2.goto('/');

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
    await page1.waitForTimeout(500);

    await page1.evaluate((staleId) => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'send-to-connection',
          payload: { connectionId: staleId, text: 'hello ghost' },
        }),
      );
    }, page2ConnId);

    await page1.waitForTimeout(1000);
    await expect(page1.getByTestId('status')).toHaveText('connected');

    await page1.close();
    await page2.close();
  });

  test('top-level broadcast reaches second client', async ({ browser }) => {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto('/');
    await page2.goto('/');

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

  test('broadcast stream reaches second client', async ({ browser }) => {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto('/');
    await page2.goto('/');

    await page1.getByTestId('username-input').fill('user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');

    await page2.getByTestId('username-input').fill('user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');

    await page1.getByTestId('broadcast-stream-btn').click();
    await waitForText(page2, 'broadcast-stream-tokens', /hello/, 15_000);

    await page1.close();
    await page2.close();
  });
});

// ═══════════════════════════════════════════════════════════════
// Replay Handler — /ws/replay
// ═══════════════════════════════════════════════════════════════

test.describe('replay handler', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/replay');
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('sends and receives messages', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /testuser: hello from replay/);
  });

  test('sequence numbers present', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    const seq = await page.getByTestId('last-seq').textContent();
    expect(Number(seq)).toBeGreaterThan(0);
  });

  test('replay returns stored messages after sending', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);

    const beforeCount = (await page.getByTestId('messages').textContent())!.split(' | ').length;
    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(1000);
    const afterCount = (await page.getByTestId('messages').textContent())!.split(' | ').length;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  test('excluded events not replayed (cursor excluded)', async ({ page }) => {
    await page.getByTestId('send-cursor-btn').click();
    await waitForText(page, 'cursor-events', /100,200/);

    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);

    const cursorCountBefore = (await page.getByTestId('cursor-events').textContent())!.split(
      ' | ',
    ).length;
    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(1000);

    const messagesAfter = await page.getByTestId('messages').textContent();
    expect(messagesAfter).toContain('hello from replay');

    const cursorCountAfter = (await page.getByTestId('cursor-events').textContent())!.split(
      ' | ',
    ).length;
    expect(cursorCountAfter).toBe(cursorCountBefore);
  });

  test('channel-scoped replay returns only channel messages', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');

    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);

    await page.getByTestId('room-send-btn').click();
    await waitForText(page, 'room-messages', /room hello/);

    await page.getByTestId('room-replay-btn').click();
    await page.waitForTimeout(1000);

    const roomReplayCount = Number(await page.getByTestId('room-replay-count').textContent());
    expect(roomReplayCount).toBeGreaterThan(0);
  });

  test('programmatic sendReplay delivers message', async ({ page }) => {
    await page.getByTestId('request-history-btn').click();
    await waitForText(page, 'history-injected', 'true');
  });

  test('channel sendReplay delivers message in channel scope', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');
    await page.getByTestId('request-room-history-btn').click();
    await waitForText(page, 'room-history-injected', 'true');
  });

  test('sequence persistence across reconnection', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    await page.getByTestId('send-msg-btn').click();
    await page.waitForTimeout(300);
    await page.getByTestId('send-msg-btn').click();
    await page.waitForTimeout(300);
    const oldSeq = Number(await page.getByTestId('last-seq').textContent());
    expect(oldSeq).toBeGreaterThan(0);

    await page.getByTestId('disconnect-btn').click();
    await waitForText(page, 'status', 'disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');

    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    await page.waitForTimeout(300);
    const newSeq = Number(await page.getByTestId('last-seq').textContent());
    expect(newSeq).toBeGreaterThan(oldSeq);
  });

  test('replay from nonzero since', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    const seq1 = Number(await page.getByTestId('last-seq').textContent());

    await page.getByTestId('send-msg-btn').click();
    await page.waitForTimeout(300);
    await page.getByTestId('send-msg-btn').click();
    await page.waitForTimeout(300);
    const seqAfter = Number(await page.getByTestId('last-seq').textContent());
    expect(seqAfter).toBeGreaterThan(seq1);

    await page.getByTestId('since-input').fill(String(seq1));
    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(1000);

    const replayCount = Number(await page.getByTestId('replay-count').textContent());
    expect(replayCount).toBeGreaterThan(0);
    expect(replayCount).toBeLessThanOrEqual(seqAfter - seq1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Custom Replay Handler — /ws/replay-custom
// ═══════════════════════════════════════════════════════════════

test.describe('custom replay handler', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/replay-custom');
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('sends and receives notes', async ({ page }) => {
    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /testuser: custom replay note/);
  });

  test('custom replay returns stored notes', async ({ page }) => {
    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /custom replay note/);

    const beforeCount = (await page.getByTestId('notes').textContent())!.split(' | ').length;
    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(1000);
    const afterCount = (await page.getByTestId('notes').textContent())!.split(' | ').length;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  test('channel-scoped custom replay returns channel messages', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');

    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /custom replay note/);

    await page.getByTestId('room-note-btn').click();
    await waitForText(page, 'room-notes', /channel replay note/);

    await page.getByTestId('room-replay-btn').click();
    await page.waitForTimeout(1000);

    const roomReplayCount = Number(await page.getByTestId('room-replay-count').textContent());
    expect(roomReplayCount).toBeGreaterThan(0);
  });

  test('onAfterSend marks messages as confirmed', async ({ page }) => {
    await page.getByTestId('add-note-btn').click();
    await waitForText(page, 'notes', /custom replay note/);
    await page.waitForTimeout(500);

    await page.getByTestId('confirmed-btn').click();
    await waitForText(page, 'confirmed-result', /total:\d+,confirmed:\d+/);

    const result = await page.getByTestId('confirmed-result').textContent();
    const match = result!.match(/total:(\d+),confirmed:(\d+)/);
    expect(Number(match![1])).toBeGreaterThan(0);
    expect(Number(match![2])).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Replay Snapshot Handler — /ws/replay-snapshot
// ═══════════════════════════════════════════════════════════════

test.describe('replay-snapshot handler', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/replay-snapshot');
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('snapshot mode: only latest value per key replayed', async ({ page }) => {
    await page.getByTestId('update-doc-a-btn').click();
    await page.waitForTimeout(300);
    await page.getByTestId('update-doc-a2-btn').click();
    await page.waitForTimeout(500);

    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(1000);

    const snapshots = await page.getByTestId('snapshots').textContent();
    const aEntries = snapshots!.split(' | ').filter((s) => s.startsWith('A:'));
    expect(aEntries).toHaveLength(1);
    expect(aEntries[0]).toBe('A:second-title');
  });

  test('best-effort durability: message replayable after async write', async ({ page }) => {
    await page.getByTestId('update-doc-b-btn').click();
    await page.waitForTimeout(500);

    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(1000);

    const snapshots = await page.getByTestId('snapshots').textContent();
    expect(snapshots).toContain('B:doc-b-title');
  });

  test('retention pruning: maxMessages limits replayed snapshots', async ({ page }) => {
    await page.getByTestId('flood-btn').click();
    await page.waitForTimeout(1000);

    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(1000);

    const replayCount = Number(await page.getByTestId('replay-count').textContent());
    expect(replayCount).toBeLessThanOrEqual(5);
    expect(replayCount).toBeGreaterThan(0);
  });

  test('reduce: multiple increments merge into accumulated total', async ({ page }) => {
    await page.getByTestId('increment-counter-btn').click();
    await page.waitForTimeout(300);
    await page.getByTestId('increment-counter-btn2').click();
    await page.waitForTimeout(300);
    await page.getByTestId('increment-counter-btn').click();
    await page.waitForTimeout(500);

    await page.getByTestId('counter-replay-btn').click();
    await page.waitForTimeout(1000);

    const snapshots = await page.getByTestId('counter-snapshots').textContent();
    const hitEntries = snapshots!.split(' | ').filter((s) => s.startsWith('hits:'));
    expect(hitEntries).toHaveLength(1);
    const total = Number(hitEntries[0]!.split(':')[1]);
    expect(total).toBe(13);
  });

  test('maxAgeMs: old messages pruned after expiry', async ({ page }) => {
    await page.getByTestId('age-test-btn').click();
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) return;
      ws.send(
        JSON.stringify({
          event: 'update-doc',
          payload: { docId: 'age-fresh', title: 'fresh-message' },
        }),
      );
    });
    await page.waitForTimeout(500);

    await page.getByTestId('replay-btn').click();
    await page.waitForTimeout(1000);

    const snapshots = await page.getByTestId('snapshots').textContent();
    expect(snapshots).not.toContain('old-message');
    expect(snapshots).toContain('fresh-message');
  });
});

// ═══════════════════════════════════════════════════════════════
// Modules Handler — /ws/modules
// ═══════════════════════════════════════════════════════════════

test.describe('modules handler', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/modules');
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('module onConnect fires (drizzle-ready)', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
  });

  test('insert record via module API', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id: \d+/);
  });

  test('get all records via module API', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);
    await page.getByTestId('get-all-btn').click();
    await waitForText(page, 'record-list', /test-item/);
  });

  test('get single record via module API', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);
    await page.getByTestId('get-one-btn').click();
    await waitForText(page, 'single-record', /test-item/);
  });

  test('delete record via module API', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);
    await page.getByTestId('delete-btn').click();
    await waitForText(page, 'delete-result', 'deleted');
  });

  test('get record count via module API', async ({ page }) => {
    await page.getByTestId('count-btn').click();
    await waitForText(page, 'record-count', /count: \d+/);
  });

  test('module onIncoming counts messages', async ({ page }) => {
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);

    await page.getByTestId('msg-count-btn').click();
    await waitForText(page, 'message-count', /messages: [3-9]|messages: \d{2,}/);
  });

  test('module scheduled task fires on trigger', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('vacuum-btn').click();
    await waitForText(page, 'vacuum-result', /vacuum:\d+/, 10_000);
  });

  test('module onOutgoing counts outgoing messages', async ({ page }) => {
    await waitForText(page, 'db-connected', 'db-ready');
    await page.getByTestId('insert-btn').click();
    await waitForText(page, 'insert-result', /id:/);

    await page.getByTestId('outgoing-count-btn').click();
    await waitForText(page, 'outgoing-count', /outgoing: [1-9]/);
  });

  test('module onDisconnect increments counter', async ({ browser }) => {
    const page1 = await browser.newPage();
    const page2 = await browser.newPage();
    await page1.goto('/modules');
    await page2.goto('/modules');

    await page1.getByTestId('username-input').fill('mod-user1');
    await page1.getByTestId('connect-btn').click();
    await waitForText(page1, 'status', 'connected');

    await page2.getByTestId('username-input').fill('mod-user2');
    await page2.getByTestId('connect-btn').click();
    await waitForText(page2, 'status', 'connected');

    await page2.evaluate(() => {
      const ws = (window as unknown as { __ws: WebSocket }).__ws;
      ws?.close();
    });
    await page1.waitForTimeout(1500);

    await page1.getByTestId('disconnect-count-btn').click();
    await waitForText(page1, 'disconnect-count', /disconnects: [1-9]/);

    await page1.close();
    await page2.close();
  });
});
