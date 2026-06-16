import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client against the real `plugins` handler. Proves the
// plugin model reaches the typed client — host traffic is typed and the
// host-observing plugin acts on it visibly, the plugin's own emit arrives under
// the `__<id>::` wire prefix, and a plugin-backed stream flows. Adapter-
// oblivious — it talks to whatever server the run booted over the /ws proxy.
async function open(page: Page, room: string): Promise<void> {
  await page.goto(`/tests/plugins/index.html?room=${room}&username=alice`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('plugins (conformance)', () => {
  test('the plugin-owned event arrives under its :: prefix with the outgoing hook stamp', async ({
    page,
  }, testInfo) => {
    await open(page, `plg-ready-${testInfo.testId}`);
    // drizzle-ready is pushed on connect under __e2e:drizzle::, and the plugin's
    // outgoing hook stamps hooked:true on it.
    await expect(page.getByTestId('drizzle-ready')).toHaveText('records');
    await expect(page.getByTestId('drizzle-hooked')).toHaveText('yes');
  });

  test('host traffic is typed and round-trips through the plugin', async ({ page }, testInfo) => {
    await open(page, `plg-host-${testInfo.testId}`);
    await page.getByTestId('insert').click();
    await expect.poll(() => page.getByTestId('inserted-id').textContent()).not.toBe('');
    expect(Number(await page.getByTestId('inserted-id').textContent())).toBeGreaterThan(0);
  });

  test('the plugin intercept rewrites a host message before it reaches the handler', async ({
    page,
  }, testInfo) => {
    await open(page, `plg-rewrite-${testInfo.testId}`);
    await page.getByTestId('rewrite').click();
    await expect(page.getByTestId('rewrite-result')).toHaveText('rewritten:hello|true');
  });

  test('the host-observing plugin counts host traffic in and out', async ({ page }, testInfo) => {
    await open(page, `plg-count-${testInfo.testId}`);
    await page.getByTestId('msg-count').click();
    await expect
      .poll(async () => Number(await page.getByTestId('msg-count-result').textContent()))
      .toBeGreaterThan(0);
    await page.getByTestId('outgoing-count').click();
    await expect
      .poll(async () => Number(await page.getByTestId('outgoing-count-result').textContent()))
      .toBeGreaterThan(0);
  });

  test('a plugin-backed stream delivers chunks built from the plugin api', async ({
    page,
  }, testInfo) => {
    await open(page, `plg-stream-${testInfo.testId}`);
    await page.getByTestId('stream-conn-id').click();
    await expect
      .poll(async () => (await page.getByTestId('stream-ids').textContent())!.split(',').length)
      .toBeGreaterThanOrEqual(3);
  });
});
