import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: a channel's subscribe payload is re-sent on reconnect. A value is
// a frozen snapshot (goes stale); a function is re-run (stays fresh). The server
// rejects a reused token, so the difference is observable end-to-end.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/subscribe-refresh/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('subscribe-refresh (conformance)', () => {
  test('a value payload goes stale on reconnect and the re-subscribe is rejected', async ({
    page,
  }, testInfo) => {
    await open(page, `sub-static-${testInfo.testId}`);
    await page.getByTestId('sub-static').click();
    await expect(page.getByTestId('subscribed')).toHaveText('1');

    await page.getByTestId('drop').click();
    await expect(page.getByTestId('status')).toHaveText('reconnecting');
    await expect(page.getByTestId('status')).toHaveText('open');

    // The reused token is refused — the channel does not re-subscribe.
    await expect(page.getByTestId('sub-failed')).not.toHaveText('');
    await expect(page.getByTestId('subscribed')).toHaveText('1');
  });

  test('a function payload refreshes on reconnect and the re-subscribe succeeds', async ({
    page,
  }, testInfo) => {
    await open(page, `sub-fn-${testInfo.testId}`);
    await page.getByTestId('sub-fn').click();
    await expect(page.getByTestId('subscribed')).toHaveText('1');
    await expect(page.getByTestId('fn-calls')).toHaveText('1');

    await page.getByTestId('drop').click();
    await expect(page.getByTestId('status')).toHaveText('reconnecting');
    await expect(page.getByTestId('status')).toHaveText('open');

    // The function ran again (a fresh token) and the channel re-subscribed.
    await expect(page.getByTestId('fn-calls')).toHaveText('2');
    await expect(page.getByTestId('subscribed')).toHaveText('2');
    await expect(page.getByTestId('sub-failed')).toHaveText('');
  });
});
