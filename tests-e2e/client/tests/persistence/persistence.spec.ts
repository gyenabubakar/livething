import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: @wskit/client's channels() + reconnection() against the real
// `persistence` server definition. Adapter-oblivious — it talks to whatever server the run
// booted over the /ws proxy.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/persistence/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

async function openMember(
  browser: Browser,
  room: string,
  username: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await open(page, room, username);
  return { page, close: () => ctx.close() };
}

test.describe('persistence (conformance)', () => {
  test('a persistent channel auto-rejoins on reconnect and a witness broadcast reaches it', async ({
    browser,
  }, testInfo) => {
    const room = `persist-rejoin-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await alice.page.getByTestId('sub-archive').click();
    await bob.page.getByTestId('sub-archive').click();
    await expect(alice.page.getByTestId('archive-subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('archive-subscribed')).toHaveText('yes');

    // Reload alice into a COLD client (its in-memory subscription is gone, so it
    // does NOT re-subscribe). On reconnect the engine restores her durable
    // membership and pushes an unsolicited subscribe — onSubscribed fires with
    // source 'server'.
    await alice.page.reload();
    await expect(alice.page.getByTestId('app-ready')).toHaveText('yes');
    await alice.page.getByTestId('connect').click();
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('server-rejoins')).toHaveText('1');

    // members repopulates after the rejoin's fresh member sync.
    await expect.poll(() => alice.page.getByTestId('members-count').textContent()).not.toBe('0');

    // Bob (witness) broadcasts WITHOUT alice re-subscribing — the message still
    // reaches alice's rejoined socket.
    await bob.page.getByTestId('send-archive').click();
    await expect(alice.page.getByTestId('room-messages')).toContainText('bob:hello rejoined alice');

    await alice.close();
    await bob.close();
  });

  test('a non-persistent channel does NOT auto-rejoin on reconnect', async ({ page }, testInfo) => {
    await open(page, `persist-ephemeral-${testInfo.testId}`, 'alice');

    await page.getByTestId('sub-typing').click();
    await expect(page.getByTestId('typing-subscribed')).toHaveText('yes');

    // A cold reload + reconnect: the engine has nothing to auto-rejoin for an
    // opt-out persistent channel, so no server-sourced subscription arrives.
    await page.reload();
    await expect(page.getByTestId('app-ready')).toHaveText('yes');
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('open');
    await page.waitForTimeout(500);

    await expect(page.getByTestId('typing-server-rejoins')).toHaveText('0');
  });
});
