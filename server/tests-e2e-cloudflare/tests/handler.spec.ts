import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
}

test.describe('main handler', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/?room=${room}`);
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
    await expect(page.getByTestId('ai-nudge-stream-tokens')).toHaveText(/.+/);
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
    await page.getByTestId('echo-btn').click();
    await waitForText(page, 'echo-result', /hello world/);
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
    await waitForText(page, 'defer-exhausted-result', /always-defer:retries=3/, 15_000);
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
    await expect(page.getByTestId('ai-nudge-stream-tokens')).toHaveText(/.+/);
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
    await page.getByTestId('echo-btn').click();
    await waitForText(page, 'echo-result', /hello world/);
    const reply = await page.getByTestId('ai-blocked-reply').textContent();
    expect(reply).toBe('');
  });

  // --- Scheduled every ---

  test('scheduled every: heartbeat fires repeatedly', async ({ page }) => {
    await page.getByTestId('start-heartbeat-btn').click();
    await expect(async () => {
      const count = Number(await page.getByTestId('heartbeat-count').textContent());
      expect(count).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 15_000 });
  });

  // --- Scheduled retry with custom backoff ---

  test('scheduled retry: flaky task succeeds after retries', async ({ page }) => {
    await page.getByTestId('trigger-flaky-btn').click();
    await waitForText(page, 'flaky-task-result', /attempts:/, 10_000);
    const result = await page.getByTestId('flaky-task-result').textContent();
    expect(result).toMatch(/attempts:[3-9]/);
  });

  test('scheduled retry: default retry succeeds after one retry', async ({ page }) => {
    await page.getByTestId('trigger-default-retry-btn').click();
    await waitForText(page, 'default-retry-result', /attempts:2/, 10_000);
  });

  test('cancelScheduled filter cancels only matching runs', async ({ page }) => {
    await page.getByTestId('schedule-filtered-btn').click();
    await page.getByTestId('cancel-filtered-drop-btn').click();
    await expect(async () => {
      const result = await page.getByTestId('filtered-task-result').textContent();
      expect(result).toContain('keep');
      expect(result).not.toContain('drop');
    }).toPass({ timeout: 10_000 });
  });

  test('scheduled dead-letter: always-fail task lands in DLQ', async ({ page }) => {
    await page.getByTestId('trigger-always-fail-btn').click();
    await expect(async () => {
      await page.getByTestId('query-dead-letter-btn').click();
      const result = await page.getByTestId('dead-letter-result').textContent();
      expect(result).toMatch(/always-fail-task:attempts=/);
    }).toPass({ timeout: 10_000 });
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
    await page.getByTestId('cancel-cleanup-btn').click();
    await waitForText(page, 'cancel-result', 'cancelled');
    await page.getByTestId('echo-btn').click();
    await waitForText(page, 'echo-result', /hello world/);
    const result = await page.getByTestId('scheduled-result').textContent();
    expect(result).toBe('');
  });

  // --- Stream cancel ---

  test('stream cancel: client cancels mid-stream', async ({ page }) => {
    await page.getByTestId('ai-stream-btn').click();
    await expect(page.getByTestId('ai-stream-tokens')).toHaveText(/.+/);
    await page.getByTestId('ai-stream-cancel-btn').click();
    await expect(async () => {
      const tokens = await page.getByTestId('ai-stream-tokens').textContent();
      expect(tokens!.length).toBeGreaterThan(0);
      expect(tokens!.length).toBeLessThan(300);
    }).toPass({ timeout: 5_000 });
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
    await waitForText(page, 'echo-result', /hello world/);
    const ids = await page.getByTestId('received-message-ids').textContent();
    const idList = ids!.split(',').filter(Boolean);
    expect(idList.length).toBeGreaterThanOrEqual(2);
    expect(new Set(idList).size).toBe(idList.length);
  });

  // --- stream cancel sends cancel ack ---

  test('stream cancel sends cancel ack', async ({ page }) => {
    await page.getByTestId('ai-nudge-stream-btn').click();
    await expect(page.getByTestId('ai-nudge-stream-tokens')).toHaveText(/.+/);
    await page.getByTestId('ai-stream-cancel-btn').click();
    await waitForText(page, 'stream-cancel-result', 'cancelled');
  });

  // --- multiple nudge types in single stream ---

  test('ai namespace: compose speed-up then pause in single stream', async ({ page }) => {
    await page.getByTestId('ai-nudge-stream-btn').click();
    await expect(page.getByTestId('ai-nudge-stream-tokens')).toHaveText(/.+/);
    await page.getByTestId('ai-speed-up-btn').click();
    await expect(async () => {
      const tokens = await page.getByTestId('ai-nudge-stream-tokens').textContent();
      expect(tokens!.length).toBeGreaterThan(5);
    }).toPass({ timeout: 5_000 });
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
    await page.getByTestId('echo-btn').click();
    await waitForText(page, 'echo-result', /hello world/);
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  // --- onShutdown hook fires via adapter.shutdown() ---

  test('onShutdown: broadcasts user-left before closing connections', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const shutdownResponse = await page.request.post(`/ws/shutdown?room=${room}`);
    expect(shutdownResponse.status()).toBe(204);
    await waitForText(page, 'user-events', /left: server-shutdown/);
    await waitForText(page, 'status', 'disconnected', 15_000);
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
    await page.getByTestId('echo-btn').click();
    await waitForText(page, 'echo-result', /hello world/);
    await expect(page.getByTestId('status')).toHaveText('connected');
  });
});
