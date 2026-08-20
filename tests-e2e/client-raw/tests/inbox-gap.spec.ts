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

// Raw-wire conformance for inbox OVERFLOW against the real worker. `chat` keeps
// at most one undelivered row per member (retention.maxMessages: 1). While a
// member is offline, a second broadcast evicts the first held row and lifts that
// member's overflow watermark. On reconnect, the drain emits a `__gap__` for the
// channel before the surviving row. At the raw-wire level the `__gap__` frame is
// directly observable. The SDK's inbox primitive consumes and acknowledges it;
// replay() is only needed to expose the gap through the application-facing
// onGap callback.

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
    expect(typeof gap.payload.missedThrough).toBe('number');
    const missedThrough = gap.payload.missedThrough as number;
    expect(missedThrough).toBeGreaterThan(0);

    const surviving = await waitForFrame(
      alice.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'm2',
    );
    expect(surviving.__wskit?.channel).toBe('chat');
    expect(surviving.__wskit?.seq).toBeGreaterThan(missedThrough);

    // The gap is not cleared merely by sending it. With no acknowledgement,
    // the watermark and surviving row must both be sent again on reconnect.
    await closeSocket(alice.page);
    await reconnect(alice.page);

    const repeatedGap = await waitForFrame(
      alice.page,
      (f) => f.event === '__gap__' && f.__wskit?.channel === 'chat',
    );
    expect(repeatedGap.payload.missedThrough).toBe(missedThrough);

    const repeatedSurviving = await waitForFrame(
      alice.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'm2',
    );
    expect(repeatedSurviving.__wskit?.seq).toBe(surviving.__wskit?.seq);

    // A cumulative receipt covering the surviving row also covers the gap's
    // missed-through watermark. The next reconnect must be empty.
    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: repeatedSurviving.__wskit?.seq },
      __wskit: { channel: 'chat' },
    });
    await alice.page.waitForTimeout(300);

    await closeSocket(alice.page);
    await reconnect(alice.page);
    await alice.page.waitForTimeout(600);
    expect(
      (await frames(alice.page)).filter(
        (f) => f.event === '__gap__' || (f.event === 'room-msg' && f.payload.text === 'm2'),
      ),
    ).toHaveLength(0);

    await alice.close();
    await bob.close();
  });
});
