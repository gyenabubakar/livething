import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's dedup() against the real wskit `dedup` handler.
// Adapter-oblivious — it talks to whatever server the run booted over the /ws
// proxy.
//
// Gap (cannot be proven from the client through THIS handler): dedup()'s DROP
// path needs two incoming frames carrying the SAME messageId. The server stamps
// every outgoing frame with a fresh, monotonic messageId (server dedup
// `generateId('msg')`), so two echoes always have distinct ids; and the server's
// own incoming dedup drops a repeated `do-echo` before it can echo twice. The
// contract declares no replay, so there is no resend path that reuses an id.
// What is provable here: dedup() is transparent to legitimate distinct-id
// traffic — every echo reaches the on() handler, none is spuriously dropped.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/dedup/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('dedup (conformance)', () => {
  test('dedup() delivers an echo whose messageId it has not seen', async ({ page }, testInfo) => {
    await open(page, `dedup-once-${testInfo.testId}`);
    await page.getByTestId('echo').click();
    await expect(page.getByTestId('echo-count')).toHaveText('1');
  });

  test('dedup() does not drop distinct-id echoes — each one reaches on()', async ({
    page,
  }, testInfo) => {
    await open(page, `dedup-distinct-${testInfo.testId}`);
    await page.getByTestId('echo').click();
    await expect(page.getByTestId('echo-count')).toHaveText('1');
    await page.getByTestId('echo').click();
    await expect(page.getByTestId('echo-count')).toHaveText('2');
    await page.getByTestId('echo').click();
    await expect(page.getByTestId('echo-count')).toHaveText('3');
  });
});
