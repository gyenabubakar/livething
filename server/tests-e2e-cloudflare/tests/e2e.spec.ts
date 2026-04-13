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
    await page.getByTestId('disconnect-btn').click();
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

  // --- Validation / Defer / Block ---

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

  // --- Channel members + subscribe rejection ---

  test('channel members count after join', async ({ page }) => {
    await page.getByTestId('chat-join-btn').click();
    await waitForText(page, 'chat-subscribed', 'subscribed');
    await page.getByTestId('get-members-btn').click();
    await waitForText(page, 'channel-members-result', /chat:\d+/);
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
});
