import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: @livething/client's replay() against the real LiveThing `replay` server definition,
// which uses LOG-mode replay (every missed message comes back, not just the
// latest) and a replay-enabled channel. Catch-up is only observable for frames
// missed while offline, so each test uses a witness that publishes while the
// subject is down.
async function open(page: Page, room: string, username: string): Promise<void> {
  await page.goto(`/tests/replay-history/index.html?room=${room}&username=${username}`);
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

test.describe('replay-history (conformance)', () => {
  test('log-mode replay delivers every top-level message missed while offline', async ({
    browser,
  }, testInfo) => {
    const room = `replay-log-${testInfo.testId}`;
    const alice = await openClient(browser, room, 'alice');
    const bob = await openClient(browser, room, 'bob');

    // Alice sees one message (so she has a top-level seq to replay from).
    await alice.page.getByTestId('send-m1').click();
    await expect(alice.page.getByTestId('messages')).toHaveText('m1');

    await alice.page.getByTestId('drop').click();
    await expect(alice.page.getByTestId('status')).toHaveText('reconnecting');

    // Bob publishes TWO messages while Alice is offline.
    await bob.page.getByTestId('send-m2').click();
    await bob.page.getByTestId('send-m3').click();

    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('reconnects')).not.toHaveText('0');

    // Log mode replays BOTH missed messages (not collapsed like snapshot mode).
    await expect(alice.page.getByTestId('messages')).toContainText('m2');
    await expect(alice.page.getByTestId('messages')).toContainText('m3');

    await alice.close();
    await bob.close();
  });

  test('channel-scoped replay catches up a channel message missed while offline', async ({
    browser,
  }, testInfo) => {
    const room = `replay-chan-${testInfo.testId}`;
    const alice = await openClient(browser, room, 'alice');
    const bob = await openClient(browser, room, 'bob');

    await alice.page.getByTestId('sub-room').click();
    await bob.page.getByTestId('sub-room').click();
    await expect(alice.page.getByTestId('room-subscribed')).toHaveText('yes');
    await expect(bob.page.getByTestId('room-subscribed')).toHaveText('yes');

    // Alice sees one channel message (so she has a per-channel seq).
    await alice.page.getByTestId('room-r1').click();
    await expect(alice.page.getByTestId('room-messages')).toContainText('r1');

    await alice.page.getByTestId('drop').click();
    await expect(alice.page.getByTestId('status')).toHaveText('reconnecting');

    // Bob publishes into the channel while Alice is offline.
    await bob.page.getByTestId('room-r2').click();

    // Alice reconnects, re-subscribes, and sends a per-channel __replay__ that
    // catches her up on the channel message she missed.
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('reconnects')).not.toHaveText('0');
    await expect(alice.page.getByTestId('room-messages')).toContainText('r2');

    await alice.close();
    await bob.close();
  });

  test('top-level replay catches up a PLUGIN-owned event missed while offline', async ({
    browser,
  }, testInfo) => {
    // The host lists no plugin replay — a plugin cannot own the host-only replay
    // engine. It only lists top-level replay.history(). This proves that engine
    // covers a plugin's own broadcast: the plugin's `ping-all` handler broadcasts
    // `plugin-msg`, which leaves the server namespaced as `__e2e:replay::plugin-msg`
    // and is stored by the top-level replay like any other outgoing frame.
    const room = `replay-plugin-${testInfo.testId}`;
    const alice = await openClient(browser, room, 'alice');
    const bob = await openClient(browser, room, 'bob');

    // Alice sees one top-level message so she has a seq to replay from. She must
    // NOT see the plugin frame live — the client would dedup the replayed copy
    // by its messageId — so bob (a witness) triggers the plugin broadcast, which
    // excludes its own sender, only while alice is offline.
    await alice.page.getByTestId('send-m1').click();
    await expect(alice.page.getByTestId('messages')).toHaveText('m1');

    await alice.page.getByTestId('drop').click();
    await expect(alice.page.getByTestId('status')).toHaveText('reconnecting');

    await bob.page.getByTestId('ping-plugin').click();

    // Alice reconnects and her top-level __replay__ hands back the plugin's frame,
    // which her typed client delivers under the plugin's `__<id>::` wire prefix.
    await expect(alice.page.getByTestId('status')).toHaveText('open');
    await expect(alice.page.getByTestId('reconnects')).not.toHaveText('0');
    await expect(alice.page.getByTestId('plugin-messages')).toHaveText('p1');

    await alice.close();
    await bob.close();
  });
});
