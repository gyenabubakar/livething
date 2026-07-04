import { expect, test } from '@playwright/test';
import {
  closeSocket,
  frames,
  openMember,
  reconnect,
  send,
  subscribe,
  waitForFrame,
} from './_inbox-rig.ts';

// Raw-wire conformance for the durable inbox against the real Cloudflare worker.
// `chat` is a persistent, inbox-backed channel: every broadcast writes one
// durable row per member and holds it until that member acks `__received__`. A
// member OFFLINE at broadcast time still gets the message — persistence
// auto-rejoins its channel on reconnect and the drain re-delivers the held row.
// After it acks, a later reconnect must not re-deliver it.

test.describe('inbox (raw wire, guaranteed per-member delivery)', () => {
  test('__subscribeOk__ carries inbox:true', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/inbox', room, username: 'alice' });

    const ack = await subscribe(alice.page);
    expect(ack.__wskit?.inbox).toBe(true);

    await alice.close();
  });

  test('a live member receives an inbox broadcast', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/inbox', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/inbox', room, username: 'bob' });

    await subscribe(alice.page);
    await subscribe(bob.page);

    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'live-hello' },
      __wskit: { channel: 'chat' },
    });

    // The channel broadcast excludes the sender, so alice (a live member)
    // receives it and bob does not witness his own.
    const msg = await waitForFrame(
      alice.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'live-hello',
    );
    expect(msg.__wskit?.channel).toBe('chat');
    expect(typeof msg.__wskit?.seq).toBe('number');

    await alice.close();
    await bob.close();
  });

  test('an offline member is drained on reconnect and its ack stops re-delivery', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/inbox', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/inbox', room, username: 'bob' });

    // Both subscribe so their durable memberships exist — inbox fan-out writes
    // one row per durable member on each broadcast.
    await subscribe(alice.page);
    await subscribe(bob.page);

    // Alice goes offline BEFORE bob broadcasts.
    await closeSocket(alice.page);

    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'while-offline' },
      __wskit: { channel: 'chat' },
    });
    // Give the broadcast time to persist alice's held row.
    await bob.page.waitForTimeout(300);

    // Reconnect: persistence auto-rejoins chat, then the drain re-delivers the
    // held row. Guaranteed delivery — the offline window did not drop it.
    await reconnect(alice.page);
    const drained = await waitForFrame(
      alice.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'while-offline',
    );
    const seq = drained.__wskit?.seq as number;

    // Alice acks it, settling (deleting) the durable row.
    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      __wskit: { channel: 'chat' },
    });
    await alice.page.waitForTimeout(300);

    // A second reconnect must NOT re-deliver it — the ack settled the row.
    await closeSocket(alice.page);
    await reconnect(alice.page);
    await alice.page.waitForTimeout(600);
    const redelivered = (await frames(alice.page)).filter(
      (f) => f.event === 'room-msg' && f.payload.text === 'while-offline',
    );
    expect(redelivered).toHaveLength(0);

    await alice.close();
    await bob.close();
  });
});
