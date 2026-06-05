import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Conformance: @wskit/client's namespace scoping against the real wskit
// `namespace` handler. Adapter-oblivious — it talks to whatever server the run
// booted over the /ws proxy.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/namespace/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

test.describe('namespace (conformance)', () => {
  test('namespace on/send round-trips inside the namespace', async ({ page }, testInfo) => {
    await open(page, `ns-send-${testInfo.testId}`, 'alice');
    await page.getByTestId('send-ns').click();
    await expect(page.getByTestId('ns-message')).toHaveText('hello ns');
  });

  test('a namespace event does not leak to top-level handlers', async ({ page }, testInfo) => {
    await open(page, `ns-noleak-${testInfo.testId}`, 'alice');
    await page.getByTestId('send-ns').click();
    await expect(page.getByTestId('ns-message')).toHaveText('hello ns');
    await expect(page.getByTestId('top-level-message')).toHaveText('');
  });

  test('namespace request() resolves inside the namespace', async ({ page }, testInfo) => {
    await open(page, `ns-info-${testInfo.testId}`, 'alice');
    await page.getByTestId('ns-info').click();
    await expect(page.getByTestId('ns-result')).toHaveText('ns');
  });

  test('a namespace stream() yields chunks and ends', async ({ page }, testInfo) => {
    await open(page, `ns-stream-${testInfo.testId}`, 'alice');
    await page.getByTestId('ns-stream').click();
    await expect(page.getByTestId('ns-stream-chunks')).toHaveText('0,1,2');
    await expect(page.getByTestId('ns-stream-end')).toHaveText('yes');
  });

  test('namespace send reaches only the triggering connection', async ({ browser }, testInfo) => {
    const room = `ns-percon-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const alice = await ctxA.newPage();
    const bob = await ctxB.newPage();

    await open(alice, room, 'alice');
    await open(bob, room, 'bob');

    await alice.getByTestId('send-ns').click();
    await expect(alice.getByTestId('ns-message')).toHaveText('hello ns');
    await expect(bob.getByTestId('ns-message')).toHaveText('');

    await ctxA.close();
    await ctxB.close();
  });

  test('namespace broadcast reaches all connections', async ({ browser }, testInfo) => {
    const room = `ns-bcast-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const alice = await ctxA.newPage();
    const bob = await ctxB.newPage();

    await open(alice, room, 'alice');
    await open(bob, room, 'bob');

    await alice.getByTestId('broadcast-ns').click();
    await expect(alice.getByTestId('ns-message')).toHaveText('broadcast msg');
    await expect(bob.getByTestId('ns-message')).toHaveText('broadcast msg');

    await ctxA.close();
    await ctxB.close();
  });
});
