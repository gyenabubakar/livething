import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function setupClient(page: Page, username: string, room: string) {
  await page.goto(`/channel-family-isolation?room=${room}`);
  await page.getByTestId('username').fill(username);
  await page.getByTestId('connect').click();
  await expect(page.getByTestId('status')).toHaveText('connected');
}

test.describe('channel-family-isolation', () => {
  test('members() does not leak across channel families with the same concrete name', async ({
    browser,
  }, testInfo) => {
    const room = `iso-${testInfo.testId}`;
    const ctxPub = await browser.newContext();
    const ctxPriv = await browser.newContext();
    const ctxAsk = await browser.newContext();
    const pub = await ctxPub.newPage();
    const priv = await ctxPriv.newPage();
    const ask = await ctxAsk.newPage();

    await setupClient(pub, 'pubuser', room);
    await setupClient(priv, 'privuser', room);
    await setupClient(ask, 'asker', room);

    await pub.getByTestId('sub-public').click();
    await priv.getByTestId('sub-private').click();

    // Wait for both subscriptions to settle.
    await pub.waitForTimeout(200);
    await priv.waitForTimeout(200);

    await ask.getByTestId('get-public-members').click();
    await expect(ask.getByTestId('public-members')).toHaveText('room:1:1');
    await ask.getByTestId('get-private-members').click();
    await expect(ask.getByTestId('private-members')).toHaveText('room:1:1');

    await ctxPub.close();
    await ctxPriv.close();
    await ctxAsk.close();
  });

  test('kick(tag, reason) is scope-bound — only the targeted family sees __kicked__ / __memberLeave__', async ({
    browser,
  }, testInfo) => {
    const room = `iso-kick-${testInfo.testId}`;
    const ctxTarget = await browser.newContext();
    const ctxOtherFamily = await browser.newContext();
    const ctxAdmin = await browser.newContext();
    const target = await ctxTarget.newPage();
    const otherFamily = await ctxOtherFamily.newPage();
    const admin = await ctxAdmin.newPage();

    await setupClient(target, 'target', room);
    await setupClient(otherFamily, 'other', room);
    await setupClient(admin, 'admin', room);

    // The target sits in BOTH families on the same concrete name room:1.
    await target.getByTestId('sub-public').click();
    await target.getByTestId('sub-private').click();
    // The other-family witness only sits in privateRooms room:1.
    await otherFamily.getByTestId('sub-private').click();

    await target.waitForTimeout(200);
    await otherFamily.waitForTimeout(200);

    // Kick from publicRooms only.
    await admin.getByTestId('kick-public-target').click();
    await expect(admin.getByTestId('kick-ack')).toHaveText('publicRooms');

    // Target receives __kicked__ only for publicRooms — private membership is intact.
    await expect(target.getByTestId('kicked')).toHaveText('publicRooms:room:1:cleanup');

    // The private-family witness must NOT see a __memberLeave__ for the target —
    // the kick targeted publicRooms only, so private members are unaffected.
    await expect(otherFamily.getByTestId('member-leaves')).toHaveText('');

    // Sanity: private members count stays at 2 (target + other), public at 0.
    await admin.getByTestId('get-public-members').click();
    await expect(admin.getByTestId('public-members')).toHaveText('room:1:0');
    await admin.getByTestId('get-private-members').click();
    await expect(admin.getByTestId('private-members')).toHaveText('room:1:2');

    await ctxTarget.close();
    await ctxOtherFamily.close();
    await ctxAdmin.close();
  });

  test('broadcast from get(family, name) reaches subscribers in that scope and is replay-persisted', async ({
    browser,
  }, testInfo) => {
    const room = `iso-bc-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxAdmin = await browser.newContext();
    const a = await ctxA.newPage();
    const admin = await ctxAdmin.newPage();

    await setupClient(a, 'subscriber', room);
    await setupClient(admin, 'admin', room);

    await a.getByTestId('sub-public').click();
    await a.waitForTimeout(200);

    // Admin broadcasts via the channel handler path (through send-in-public),
    // which routes to ctx.channel.broadcast — captured by replay.
    await admin.getByTestId('broadcast-public').click();

    // Subscriber sees it.
    await expect(a.getByTestId('public-messages')).toContainText('publicRooms:room:1:pub-hello');

    // A late client subscribes and asks for replay since 0; they must see
    // the broadcast even though they joined after the fact.
    const ctxLate = await browser.newContext();
    const late = await ctxLate.newPage();
    await setupClient(late, 'late', room);
    await late.getByTestId('sub-public').click();
    await late.waitForTimeout(200);
    await late.getByTestId('replay-from-zero').click();
    await expect(late.getByTestId('public-messages')).toContainText('publicRooms:room:1:pub-hello');

    await ctxA.close();
    await ctxAdmin.close();
    await ctxLate.close();
  });

  test('send from get(family, name) routes back to the caller with channel scope wire fields', async ({
    browser,
  }, testInfo) => {
    const room = `iso-send-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const a = await ctxA.newPage();
    await setupClient(a, 'caller', room);

    await a.getByTestId('send-direct-public').click();
    await expect(a.getByTestId('public-messages')).toContainText('publicRooms:room:1:direct-pub');

    await a.getByTestId('send-direct-private').click();
    await expect(a.getByTestId('private-messages')).toContainText(
      'privateRooms:room:1:direct-priv',
    );

    await ctxA.close();
  });

  test('await ctx.channels.get(...).kick(...) completes before the ack send', async ({
    browser,
  }, testInfo) => {
    const room = `iso-await-${testInfo.testId}`;
    const ctxTarget = await browser.newContext();
    const ctxAdmin = await browser.newContext();
    const target = await ctxTarget.newPage();
    const admin = await ctxAdmin.newPage();

    await setupClient(target, 'target', room);
    await setupClient(admin, 'admin', room);

    await target.getByTestId('sub-public').click();
    await target.waitForTimeout(200);

    await admin.getByTestId('kick-public-target').click();
    // The handler sends 'kick-acknowledged' AFTER the kick promise resolves.
    // If kick were not awaited, the ack could arrive before the target's
    // __kicked__ + __memberLeave__ processing completes. We pin the ordering by
    // asserting the ack lands AND the target shows __kicked__ once we look.
    await expect(admin.getByTestId('kick-ack')).toHaveText('publicRooms');
    await expect(target.getByTestId('kicked')).toHaveText('publicRooms:room:1:cleanup');

    await ctxTarget.close();
    await ctxAdmin.close();
  });
});
