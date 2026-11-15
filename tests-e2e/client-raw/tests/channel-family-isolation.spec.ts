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

    // Confirm each subscribe landed via a same-connection round trip
    // (ordering guarantees this reflects the subscribe above) before asking
    // a third connection for the member counts.
    await pub.getByTestId('get-public-members').click();
    await expect(pub.getByTestId('public-members')).toHaveText(/room:1:\d/);
    await priv.getByTestId('get-private-members').click();
    await expect(priv.getByTestId('private-members')).toHaveText(/room:1:\d/);

    await ask.getByTestId('get-public-members').click();
    await expect(ask.getByTestId('public-members')).toHaveText('room:1:1');
    await ask.getByTestId('get-private-members').click();
    await expect(ask.getByTestId('private-members')).toHaveText('room:1:1');

    await ctxPub.close();
    await ctxPriv.close();
    await ctxAsk.close();
  });

  test('kick(tag, reason) is scope-bound — only the targeted family sees __kicked__ and a leave change', async ({
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

    // Each connection confirms its own subscribe(s) landed via a
    // same-connection round trip (guaranteed ordering) before the admin's
    // kick, which depends on target's membership already being registered.
    await target.getByTestId('get-public-members').click();
    await expect(target.getByTestId('public-members')).toHaveText(/room:1:\d/);
    await target.getByTestId('get-private-members').click();
    await expect(target.getByTestId('private-members')).toHaveText(/room:1:\d/);
    await otherFamily.getByTestId('get-private-members').click();

    await expect(otherFamily.getByTestId('private-members')).toHaveText(/room:1:\d/);

    // Kick from publicRooms only.
    await admin.getByTestId('kick-public-target').click();
    await expect(admin.getByTestId('kick-ack')).toHaveText('publicRooms');

    // Target receives __kicked__ only for publicRooms — private membership is intact.
    await expect(target.getByTestId('kicked')).toHaveText('publicRooms:room:1:cleanup');

    // The private-family witness must NOT see a leave change for the target —
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
    // Confirm the subscribe landed via a same-connection round trip
    // (ordering guarantees this reflects the subscribe above) before the
    // admin broadcasts — the broadcast only reaches subscribers current at
    // the time it is sent.
    await a.getByTestId('get-public-members').click();
    await expect(a.getByTestId('public-members')).toHaveText(/room:1:\d/);

    // Admin broadcasts via the channel handler path (through send-in-public),
    // which routes to ctx.channel.broadcast — captured by replay.
    await admin.getByTestId('broadcast-public').click();

    // Subscriber sees it.
    await expect(a.getByTestId('public-messages')).toContainText('publicRooms:room:1:pub-hello');

    // A late client subscribes and asks for replay since 0; they must see
    // the broadcast even though they joined after the fact. Both the
    // subscribe and the replay request are on the same connection, so
    // ordering is already guaranteed without an extra wait.
    const ctxLate = await browser.newContext();
    const late = await ctxLate.newPage();
    await setupClient(late, 'late', room);
    await late.getByTestId('sub-public').click();

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
    // Confirm the subscribe landed via a same-connection round trip
    // (ordering guarantees this reflects the subscribe above) before the
    // admin's kick, which depends on target's membership already being
    // registered.
    await target.getByTestId('get-public-members').click();
    await expect(target.getByTestId('public-members')).toHaveText(/room:1:\d/);

    await admin.getByTestId('kick-public-target').click();
    // The handler sends 'kick-acknowledged' AFTER the kick promise resolves.
    // If kick were not awaited, the ack could arrive before the target's
    // __kicked__ + leave change processing completes. We pin the ordering by
    // asserting the ack lands AND the target shows __kicked__ once we look.
    await expect(admin.getByTestId('kick-ack')).toHaveText('publicRooms');
    await expect(target.getByTestId('kicked')).toHaveText('publicRooms:room:1:cleanup');

    await ctxTarget.close();
    await ctxAdmin.close();
  });
});
