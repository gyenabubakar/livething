import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: connection-lifecycle behaviours against the real `request`
// handler.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/lifecycle/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('lifecycle (conformance)', () => {
  test('connect() is idempotent — a second call while open does nothing', async ({
    page,
  }, testInfo) => {
    await open(page, `life-idem-${testInfo.testId}`);
    await page.getByTestId('connect').click();
    await page.getByTestId('connect').click();
    // onOpen fired exactly once: the extra connect() calls were no-ops.
    await expect(page.getByTestId('open-count')).toHaveText('1');
  });

  test('socket.ws is the live instance when open, and protocol is null', async ({
    page,
  }, testInfo) => {
    await open(page, `life-props-${testInfo.testId}`);
    await expect(page.getByTestId('ws-present')).toHaveText('yes');
    await expect(page.getByTestId('protocol')).toHaveText('null');
  });

  test('disconnect() rejects a pending request with Disconnected and closes', async ({
    page,
  }, testInfo) => {
    await open(page, `life-pending-${testInfo.testId}`);
    await page.getByTestId('start-pending').click();
    await page.getByTestId('disconnect').click();
    await expect(page.getByTestId('status')).toHaveText('closed');
    await expect(page.getByTestId('pending-error')).toHaveText('disconnected');
    await expect(page.getByTestId('ws-present')).toHaveText('no');
  });
});
