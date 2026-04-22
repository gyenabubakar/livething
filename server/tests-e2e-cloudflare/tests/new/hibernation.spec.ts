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

  test('tags survive across hibernation wake', async ({ browser }, testInfo) => {
    const room = `hib-tags-${testInfo.testId}`;

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

    // Alice tags herself before hibernation.
    await alice.getByTestId('tag-sleeper').click();
    await expect(alice.getByTestId('tags')).toContainText('alice');
    await expect(alice.getByTestId('tags')).toContainText('sleeper');

    // Idle window for hibernation.
    await alice.waitForTimeout(1_500);

    // Bob tags himself after Alice's hibernation.
    await bob.getByTestId('tag-sleeper').click();
    await expect(bob.getByTestId('tags')).toContainText('bob');
    await expect(bob.getByTestId('tags')).toContainText('sleeper');

    // Alice is woken up by Playwright's polling (expectation on the page).
    // If her tags survived, they will still be present.
    await expect(alice.getByTestId('tags')).toContainText('alice');
    await expect(alice.getByTestId('tags')).toContainText('sleeper');

    await aliceCtx.close();
    await bobCtx.close();
  });

  test('SQL state survives across hibernation wake', async ({ browser }, testInfo) => {
    const room = `hib-sql-${testInfo.testId}`;

    const writerCtx = await browser.newContext();
    const readerCtx = await browser.newContext();
    const writer = await writerCtx.newPage();
    const reader = await readerCtx.newPage();

    await writer.goto(`/hibernation?room=${room}`);
    await reader.goto(`/hibernation?room=${room}`);

    await writer.getByTestId('username').fill('writer');
    await reader.getByTestId('username').fill('reader');

    await writer.getByTestId('connect').click();
    await reader.getByTestId('connect').click();

    await expect(writer.getByTestId('status')).toHaveText('connected');
    await expect(reader.getByTestId('status')).toHaveText('connected');

    // Writer saves a note before hibernation.
    await writer.getByTestId('save-note').click();
    await expect(writer.getByTestId('saved-notes')).toContainText('test-note:test-content');

    // Idle window for hibernation.
    await writer.waitForTimeout(1_500);

    // Reader connects to the same DO and queries notes.
    // If SQL state survived, the note is visible.
    await reader.getByTestId('get-notes').click();
    await expect(reader.getByTestId('saved-notes')).toContainText('test-note:test-content');

    await writerCtx.close();
    await readerCtx.close();
  });
});
