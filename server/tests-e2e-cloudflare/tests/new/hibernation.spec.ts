import { expect, test } from '@playwright/test';

test.describe('hibernation', () => {
  test('channel membership survives across an idle window (hibernation wake)', async ({
    browser,
  }, testInfo) => {
    const room = `hib-${testInfo.testId}`;

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    await alice.goto(`/hibernation?room=${room}`);
    await bob.goto(`/hibernation?room=${room}`);

    await alice.getByTestId('username').fill('alice');
    await bob.getByTestId('username').fill('bob');

    await alice.getByTestId('connect').click();
    await bob.getByTestId('connect').click();

    await expect(alice.getByTestId('status')).toHaveText('connected');
    await expect(bob.getByTestId('status')).toHaveText('connected');

    await alice.getByTestId('subscribe-room').click();
    await bob.getByTestId('subscribe-room').click();

    await expect(alice.getByTestId('subscribed')).toHaveText('yes');
    await expect(bob.getByTestId('subscribed')).toHaveText('yes');

    // Idle window for the DO to hibernate between subscribe and broadcast.
    // Keep short so Playwright's default poll handles the wake naturally.
    await alice.waitForTimeout(1_500);

    await bob.getByTestId('broadcast-hello').click();

    // Polls default 5s — if membership was restored on wake, alice sees it.
    await expect(alice.getByTestId('room-messages')).toContainText('hello-after-wake');

    await aliceCtx.close();
    await bobCtx.close();
  });
});
