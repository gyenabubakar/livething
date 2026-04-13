import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
}

test.describe('wskit e2e', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('status')).toHaveText('disconnected');

    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('connects and disconnects', async ({ page }) => {
    await expect(page.getByTestId('status')).toHaveText('connected');

    await page.getByTestId('disconnect-btn').click();
    await waitForText(page, 'status', 'disconnected', 15_000);
  });

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

  test('triggers not-found error', async ({ page }) => {
    await page.getByTestId('error-notfound-btn').click();
    await waitForText(page, 'error-result', /not-found/);
  });

  test('triggers forbidden error', async ({ page }) => {
    await page.getByTestId('error-forbidden-btn').click();
    await waitForText(page, 'error-result', /forbidden/);
  });

  test('request-response: get-time', async ({ page }) => {
    await page.getByTestId('request-time-btn').click();
    await waitForText(page, 'time-result', /epoch:/);
  });

  test('lifecycle: user-joined on connect', async ({ page }) => {
    await waitForText(page, 'user-events', /joined: testuser/);
  });

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

  test('scheduled task fires after delay', async ({ page }) => {
    await page.getByTestId('schedule-btn').click();
    await waitForText(page, 'scheduled-result', /Cleaned \d+ items/, 15_000);
  });
});
