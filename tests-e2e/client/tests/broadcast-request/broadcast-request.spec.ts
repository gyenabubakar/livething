import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: @wskit/client's serverRequests() answering a broadcast request
// (first answer wins) against the real `broadcast-request` server definition. Two clients
// join the same `lobby`; the server fans `volunteer` out to both and resolves
// with the first valid answer plus the answerer's identity. Adapter-oblivious —
// it talks to whatever server the run booted over the /ws proxy.
async function openMember(browser: Browser, room: string, username: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/tests/broadcast-request/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();

  await expect(page.getByTestId('status')).toHaveText('open');
  await page.getByTestId('subscribe').click();
  await expect(page.getByTestId('subscribed')).toHaveText('true');

  return page;
}

test.describe('broadcast-request (conformance)', () => {
  test('the lone valid answerer wins and is reported as from', async ({ browser }, testInfo) => {
    const room = `bcast-win-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await alice.getByTestId('answer-good').click();
    await bob.getByTestId('answer-drop').click();

    await alice.getByTestId('trigger').click();

    // Both members were asked the question...
    await expect(alice.getByTestId('last-turn')).toHaveText('5');
    await expect(bob.getByTestId('last-turn')).toHaveText('5');
    // ...and the server resolved with alice's answer and identity.
    await expect(alice.getByTestId('outcome-from')).toHaveText('alice');
    await expect(alice.getByTestId('outcome-ready')).toHaveText('true');

    await alice.context().close();
    await bob.context().close();
  });

  test('an invalid answer never beats a valid one', async ({ browser }, testInfo) => {
    const room = `bcast-inv-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await alice.getByTestId('answer-good').click();
    await bob.getByTestId('answer-bad').click();

    await alice.getByTestId('trigger').click();

    await expect(alice.getByTestId('outcome-from')).toHaveText('alice');
    await expect(alice.getByTestId('outcome-ready')).toHaveText('true');

    await alice.context().close();
    await bob.context().close();
  });

  test('nobody answers before the timeout rejects with timeout', async ({ browser }, testInfo) => {
    const room = `bcast-to-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await alice.getByTestId('answer-drop').click();
    await bob.getByTestId('answer-drop').click();

    await alice.getByTestId('trigger-timeout').click();

    await expect(alice.getByTestId('last-turn')).toHaveText('9');
    await expect(bob.getByTestId('last-turn')).toHaveText('9');
    await expect(alice.getByTestId('error-outcome')).toHaveText('timeout');

    await alice.context().close();
    await bob.context().close();
  });
});
