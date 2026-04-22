import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('incoming', () => {
  async function openPage(page: Page, room: string) {
    await page.goto(`/incoming?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected', { timeout: 15_000 });
  }

  test('incoming handler runs when the matching event arrives', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('send-hello').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello');
  });

  test('_replay against a handler without replay enabled is handled gracefully', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Send _replay; server should drop it silently (not crash the connection).
    await page.getByTestId('send-replay').click();
    // Connection must stay alive and process subsequent frames normally.
    await page.getByTestId('send-hello').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello');
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('bad payload is rejected before the handler runs (validator fires)', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Send a frame with invalid payload (text is number instead of string).
    // Validator should reject it, handler should not run, onValidationError fires.
    await page.getByTestId('send-bad').click();
    await expect(page.getByTestId('validation-error')).toHaveText('echo-ping');
    // Verify handler never ran: echoed should still be empty.
    await expect(page.getByTestId('echoed')).toHaveText('');
    // Connection stays alive.
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('async handler is awaited before next frame is processed', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Send async ping; verify result appears before we send the next frame.
    await page.getByTestId('send-async').click();
    await expect(page.getByTestId('async-result')).toHaveText('async-done');
    // If async handler were not awaited, the order would be unpredictable.
    await page.getByTestId('send-hello').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello');
  });

  test('unregistered event is silently dropped', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Send an event that has no handler registered.
    await page.getByTestId('send-unknown').click();
    // Handler never runs, no error fires, connection stays alive.
    await expect(page.getByTestId('status')).toHaveText('connected');
    // Verify subsequent frames work normally.
    await page.getByTestId('send-hello').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello');
  });

  test('frame without event field is dropped', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // Send a frame with no event field (or invalid JSON).
    await page.getByTestId('send-no-event').click();
    // Invalid JSON is silently dropped, connection stays alive.
    await expect(page.getByTestId('status')).toHaveText('connected');
    await page.getByTestId('send-hello').click();
    await expect(page.getByTestId('echoed')).toHaveText('hello');
  });
});
