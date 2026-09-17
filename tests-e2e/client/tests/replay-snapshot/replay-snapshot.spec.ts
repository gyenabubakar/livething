import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: @wskit/client's replay() against the real wskit `replay-snapshot`
// server definition. Adapter-oblivious — it talks to whatever server the run booted over
// the /ws proxy.
//
// Replay catch-up can only be observed for frames the client MISSED while down:
// a frame it already saw is re-sent on reconnect but dropped by dedup(). So each
// test connects two clients — the subject drops, a witness publishes while the
// subject is offline, and replay() must deliver that missed update on reconnect.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/replay-snapshot/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('open');
}

async function openClient(
  browser: Browser,
  room: string,
  username: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await open(page, room, username);
  return { page, close: () => ctx.close() };
}

test.describe('replay-snapshot (conformance)', () => {
  test('replay() delivers an update the client missed while disconnected', async ({
    browser,
  }, testInfo) => {
    const room = `replay-catchup-${testInfo.testId}`;
    const alice = await openClient(browser, room, 'alice');
    const bob = await openClient(browser, room, 'bob');

    // Alice sees the first value (so she has a seq to replay from).
    await alice.page.getByTestId('update-a-first').click();
    await expect(alice.page.getByTestId('snapshots')).toHaveText('A:first-title');

    // Drop Alice and wait until she is actually offline.
    await alice.page.getByTestId('drop').click();
    await expect(alice.page.getByTestId('status')).toHaveText('reconnecting');

    // Bob publishes the newer value while Alice is offline — she misses it live.
    await bob.page.getByTestId('update-a-second').click();

    // Alice reconnects; replay() catches her up to the value she missed.
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('reconnects')).not.toHaveText('0');
    await expect(alice.page.getByTestId('snapshots')).toHaveText('A:second-title');

    await alice.close();
    await bob.close();
  });

  test('replay catch-up keeps only the latest value per key (snapshot mode)', async ({
    browser,
  }, testInfo) => {
    const room = `replay-latest-${testInfo.testId}`;
    const alice = await openClient(browser, room, 'alice');
    const bob = await openClient(browser, room, 'bob');

    await alice.page.getByTestId('update-a-first').click();
    await expect(alice.page.getByTestId('snapshots')).toHaveText('A:first-title');

    await alice.page.getByTestId('drop').click();
    await expect(alice.page.getByTestId('status')).toHaveText('reconnecting');

    // Two updates to the same key while Alice is offline.
    await bob.page.getByTestId('update-a-first').click();
    await bob.page.getByTestId('update-a-second').click();

    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('reconnects')).not.toHaveText('0');

    // Snapshot mode collapses the two missed writes to the latest — exactly one
    // A entry comes back, carrying the newer title.
    await expect(alice.page.getByTestId('snapshots')).toHaveText('A:second-title');
    const snapshots = await alice.page.getByTestId('snapshots').textContent();
    expect(snapshots!.split(' | ').filter((s) => s.startsWith('A:'))).toEqual(['A:second-title']);

    await alice.close();
    await bob.close();
  });
});
