import { expect, test } from '@playwright/test';

test.describe('ctx-channels', () => {
  test('ctx.channels.members returns the count after a client joins', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/ctx-channels?room=${room}`);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribed')).toHaveText('yes');

    await page.getByTestId('get-members').click();
    await expect(page.getByTestId('members-result')).toHaveText('room:1');
  });

  test('ctx.channels.kick delivers _kicked to the target with the given reason', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await a.goto(`/ctx-channels?room=${room}`);
    await b.goto(`/ctx-channels?room=${room}`);
    await a.getByTestId('username').fill('user1');
    await b.getByTestId('username').fill('user2');
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await expect(a.getByTestId('status')).toHaveText('connected');
    await expect(b.getByTestId('status')).toHaveText('connected');
    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribed')).toHaveText('yes');
    await expect(b.getByTestId('subscribed')).toHaveText('yes');

    await a.getByTestId('kick-user2').click();
    await expect(b.getByTestId('kicked-result')).toContainText('room');
    await expect(b.getByTestId('kicked-result')).toContainText('Kicked by admin');

    await ctxA.close();
    await ctxB.close();
  });

  test('members count updates after kick and kicked client is isolated', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await a.goto(`/ctx-channels?room=${room}`);
    await b.goto(`/ctx-channels?room=${room}`);
    await a.getByTestId('username').fill('user1');
    await b.getByTestId('username').fill('user2');
    await a.getByTestId('connect').click();
    await b.getByTestId('connect').click();
    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribed')).toHaveText('yes');
    await expect(b.getByTestId('subscribed')).toHaveText('yes');

    await a.getByTestId('get-members').click();
    await expect(a.getByTestId('members-result')).toHaveText('room:2');

    await a.getByTestId('kick-user2').click();
    await expect(b.getByTestId('kicked-result')).toContainText('room');

    await a.getByTestId('get-members').click();
    await expect(a.getByTestId('members-result')).toHaveText('room:1');

    // Post-kick, user2's send should be dropped (no longer a member).
    await b.getByTestId('send-after-kick').click();

    // Positive signal: user2 re-subscribes and sends again; user1 should see
    // only the second message. If the first had leaked through, it'd be in
    // user1's room-messages too.
    await b.getByTestId('subscribe-room').click();
    await b.getByTestId('send-after-resub').click();
    await expect(a.getByTestId('room-messages')).toContainText('user2:after-resub');
    await expect(a.getByTestId('room-messages')).not.toContainText('user2:after-kick');

    await ctxA.close();
    await ctxB.close();
  });
});
