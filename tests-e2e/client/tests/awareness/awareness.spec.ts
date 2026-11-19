import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

// Conformance: `channel.awareness` of @livething/client against the real server definition.
// Members of Huddle's #general room share which message they are reading. Each page renders
// the stores: `others` as sorted `name=message` pairs, `self` and `mine` for this connection,
// `synced`, and the reasons `onRefused` got. Usernames that start with `guest` sign in as
// guests, whose states the room's `check` refuses.
async function openMember(
  browser: Browser,
  room: string,
  username: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/tests/awareness/index.html?room=${room}&username=${username}`);
  await expect(page.getByTestId('app-ready')).toHaveText('yes');
  await page.getByTestId('connect').click();

  await expect(page.getByTestId('status')).toHaveText('open');

  return { page, close: () => ctx.close() };
}

async function join(page: Page): Promise<void> {
  await page.getByTestId('sub').click();
  await expect(page.getByTestId('subscribed')).toHaveText('yes');
  await expect(page.getByTestId('synced')).toHaveText('true');
}

test.describe('awareness', () => {
  test('members see each other in others, the sender sees itself in self, and synced turns true', async ({
    browser,
  }, testInfo) => {
    const room = `awareness-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');

    await expect(alice.page.getByTestId('synced')).toHaveText('false');
    await join(alice.page);
    await join(bob.page);

    await alice.page.getByTestId('view-msg-1').click();
    await expect(alice.page.getByTestId('mine')).toHaveText('msg-1');
    await expect(alice.page.getByTestId('self')).toHaveText('alice=msg-1');
    await expect(bob.page.getByTestId('others')).toHaveText('alice=msg-1');
    await expect(alice.page.getByTestId('others')).toHaveText('');

    await bob.page.getByTestId('view-msg-2').click();
    await expect(alice.page.getByTestId('others')).toHaveText('bob=msg-2');
    await expect(bob.page.getByTestId('self')).toHaveText('bob=msg-2');

    // A member who joins late gets both states in its first sync.
    const carol = await openMember(browser, room, 'carol');
    await join(carol.page);
    await expect(carol.page.getByTestId('others')).toHaveText('alice=msg-1,bob=msg-2');

    // A clear reaches the others at once.
    await alice.page.getByTestId('clear').click();
    await expect(alice.page.getByTestId('self')).toHaveText('');
    await expect(bob.page.getByTestId('others')).toHaveText('');
    await expect(carol.page.getByTestId('others')).toHaveText('bob=msg-2');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('a refused update reaches onRefused, not onServerError', async ({ browser }, testInfo) => {
    const room = `awareness-refused-${testInfo.testId}`;
    const guest = await openMember(browser, room, 'guest-gina');
    const bob = await openMember(browser, room, 'bob');
    await join(guest.page);
    await join(bob.page);

    await guest.page.getByTestId('view-msg-1').click();
    await expect(guest.page.getByTestId('refused')).toHaveText('check');
    await expect(guest.page.getByTestId('server-errors')).toHaveText('');
    // `mine` is the guest's own intent; the server never took it.
    await expect(guest.page.getByTestId('mine')).toHaveText('msg-1');
    await expect(guest.page.getByTestId('self')).toHaveText('');

    // Bob's own update is a barrier: had the guest's state been taken, it came first.
    await bob.page.getByTestId('view-msg-2').click();
    await expect(bob.page.getByTestId('self')).toHaveText('bob=msg-2');
    await expect(bob.page.getByTestId('others')).toHaveText('');

    await guest.close();
    await bob.close();
  });

  test('after a reconnect, others is kept and mine is sent again', async ({
    browser,
  }, testInfo) => {
    const room = `awareness-reconnect-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');
    await join(alice.page);
    await join(bob.page);

    await alice.page.getByTestId('view-msg-1').click();
    await bob.page.getByTestId('view-msg-2').click();
    await expect(alice.page.getByTestId('others')).toHaveText('bob=msg-2');
    await expect(bob.page.getByTestId('others')).toHaveText('alice=msg-1');

    await alice.page.getByTestId('server-drop').click();
    await expect(alice.page.getByTestId('status-log')).toHaveText(/,reconnecting,.*open$/);
    await expect(alice.page.getByTestId('synced')).toHaveText('true');

    // The new connection sends `mine` again, so self and bob's view come back.
    await expect(alice.page.getByTestId('self')).toHaveText('alice=msg-1');
    await expect(bob.page.getByTestId('others')).toHaveText('alice=msg-1');
    await expect(alice.page.getByTestId('others')).toHaveText('bob=msg-2');
    // `others` was never emptied while the socket was down.
    expect((await alice.page.getByTestId('others-sizes').textContent())!.split(',')).not.toContain(
      '0',
    );

    await alice.close();
    await bob.close();
  });

  test('unsubscribe empties the stores, and the others drop this member', async ({
    browser,
  }, testInfo) => {
    const room = `awareness-unsub-${testInfo.testId}`;
    const alice = await openMember(browser, room, 'alice');
    const bob = await openMember(browser, room, 'bob');
    await join(alice.page);
    await join(bob.page);

    await alice.page.getByTestId('view-msg-1').click();
    await bob.page.getByTestId('view-msg-2').click();
    await expect(alice.page.getByTestId('others')).toHaveText('bob=msg-2');
    await expect(bob.page.getByTestId('others')).toHaveText('alice=msg-1');

    await alice.page.getByTestId('unsub').click();
    await expect(alice.page.getByTestId('subscribed')).toHaveText('no');

    await expect(alice.page.getByTestId('others')).toHaveText('');
    await expect(alice.page.getByTestId('self')).toHaveText('');
    await expect(alice.page.getByTestId('mine')).toHaveText('');
    await expect(alice.page.getByTestId('synced')).toHaveText('false');
    await expect(bob.page.getByTestId('others')).toHaveText('');

    await alice.close();
    await bob.close();
  });

  test('two tabs of one user see each other in others, and each sees only itself in self', async ({
    browser,
  }, testInfo) => {
    const room = `awareness-tabs-${testInfo.testId}`;
    const tabA = await openMember(browser, room, 'alice');
    const tabB = await openMember(browser, room, 'alice');
    await join(tabA.page);
    await join(tabB.page);

    await tabA.page.getByTestId('view-msg-1').click();
    await tabB.page.getByTestId('view-msg-2').click();

    await expect(tabA.page.getByTestId('self')).toHaveText('alice=msg-1');
    await expect(tabA.page.getByTestId('others')).toHaveText('alice=msg-2');
    await expect(tabB.page.getByTestId('self')).toHaveText('alice=msg-2');
    await expect(tabB.page.getByTestId('others')).toHaveText('alice=msg-1');

    await tabA.close();
    await tabB.close();
  });
});
