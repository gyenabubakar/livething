import { expect, test } from '@playwright/test';
import { closeSocket, openMember, reconnect, send, subscribe, waitForFrame } from './_inbox-rig.ts';

// Raw-wire conformance for inbox OVERFLOW against the real worker. `chat` keeps
// at most one undelivered row per member (retention.maxMessages: 1). While a
// member is offline, a second broadcast evicts the first held row and lifts that
// member's overflow watermark. On reconnect, the drain emits a `__gap__` for the
// channel before the surviving row. At the raw-wire level the `__gap__` frame is
// directly observable — an SDK would need replay() to consume it, but here we
// assert the frame lands.

test.describe('inbox-gap (raw wire, overflow gap frame)', () => {
  test('overflow while offline emits a __gap__ before the surviving row on reconnect', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/inbox-gap', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/inbox-gap', room, username: 'bob' });

    await subscribe(alice.page);
    await subscribe(bob.page);

    // Alice goes offline, then bob publishes two messages. With one undelivered
    // row kept per member, m2 evicts alice's held m1 and lifts her overflow
    // watermark.
    await closeSocket(alice.page);
    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'm1' },
      __wskit: { channel: 'chat' },
    });
    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'm2' },
      __wskit: { channel: 'chat' },
    });
    await bob.page.waitForTimeout(400);

    // On reconnect the drain emits the gap for chat, then the surviving row (m2).
    // m1 is gone — that is the point of an overflow gap.
    await reconnect(alice.page);

    const gap = await waitForFrame(
      alice.page,
      (f) => f.event === '__gap__' && f.__wskit?.channel === 'chat',
    );
    expect(gap.__wskit?.channel).toBe('chat');

    const surviving = await waitForFrame(
      alice.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'm2',
    );
    expect(surviving.__wskit?.channel).toBe('chat');

    await alice.close();
    await bob.close();
  });
});
