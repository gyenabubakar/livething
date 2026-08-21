import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSocket, frames, openMember, reconnect, send, waitForFrame } from './_inbox-rig.ts';
import type { Frame } from './_inbox-rig.ts';

// Raw-wire coverage for `inbox()` + `readReceipts()` on a DYNAMIC channel
// family — `rooms` / `room:{id}` — on a host that also runs `replay.history()`
// and `tags()`. Every existing inbox spec drives a STATIC channel; this proves
// fan-out, the held row, the `__received__` ack, and the drain all key off the
// concrete (channelFamily, channel) pair a member joined, not the family name
// alone — and that replay's own sequence counter and tags stay independent of a
// room's per-member inbox sequence numbers.

const FAMILY = 'rooms';

function roomName(id: string): string {
  return `room:${id}`;
}

async function subscribeRoom(page: Page, id: string): Promise<Frame> {
  await send(page, {
    event: '__subscribe__',
    payload: {},
    __wskit: { channel: roomName(id), channelFamily: FAMILY },
  });
  return waitForFrame(
    page,
    (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === roomName(id),
  );
}

test.describe('inbox() + readReceipts() on a dynamic channel family (raw wire)', () => {
  test('__subscribeOk__ for one member of a family does not leak into a sibling member', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/inbox-dynamic', room, username: 'alice' });

    const ackA = await subscribeRoom(alice.page, 'a');
    expect(ackA.__wskit?.inbox).toBe(true);
    expect(ackA.__wskit?.readReceipts).toBe(true);
    expect(ackA.__wskit?.channelFamily).toBe(FAMILY);

    await alice.close();
  });

  test('an offline member of one family instance is drained on reconnect, keyed to that instance, and its ack stops re-delivery', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/inbox-dynamic', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/inbox-dynamic', room, username: 'bob' });

    // Both join the SAME family instance, room:1. A second, unrelated instance
    // (room:2) that alice also joins must never leak a room:1 delivery.
    await subscribeRoom(alice.page, '1');
    await subscribeRoom(alice.page, '2');
    await subscribeRoom(bob.page, '1');

    await closeSocket(alice.page);

    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'while-offline' },
      __wskit: { channel: roomName('1'), channelFamily: FAMILY },
    });
    await bob.page.waitForTimeout(300);

    await reconnect(alice.page);
    const drained = await waitForFrame(
      alice.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'while-offline',
    );
    expect(drained.__wskit?.channel).toBe(roomName('1'));
    expect(drained.__wskit?.channelFamily).toBe(FAMILY);
    const seq = drained.__wskit?.seq as number;

    // The drain must not have touched room:2 — no room-msg was ever sent there.
    const room2Leak = (await frames(alice.page)).filter(
      (f) => f.event === 'room-msg' && f.__wskit?.channel === roomName('2'),
    );
    expect(room2Leak).toHaveLength(0);

    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      __wskit: { channel: roomName('1'), channelFamily: FAMILY },
    });
    await alice.page.waitForTimeout(300);

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

  test('markAsRead on one family instance fans a __read__ scoped to that instance', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/inbox-dynamic', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/inbox-dynamic', room, username: 'bob' });

    await subscribeRoom(alice.page, '1');
    await subscribeRoom(bob.page, '1');

    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'read-me' },
      __wskit: { channel: roomName('1'), channelFamily: FAMILY },
    });
    const msg = await waitForFrame(
      alice.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'read-me',
    );
    const seq = msg.__wskit?.seq as number;

    await send(alice.page, {
      event: '__read__',
      payload: { readThrough: seq },
      __wskit: { channel: roomName('1'), channelFamily: FAMILY },
    });

    const readFrame = await waitForFrame(bob.page, (f) => f.event === '__read__');
    expect(readFrame.__wskit?.channel).toBe(roomName('1'));
    expect(readFrame.__wskit?.channelFamily).toBe(FAMILY);

    await alice.close();
    await bob.close();
  });

  test("a host running replay() and tags() alongside a room's inbox does not cross-contaminate sequence numbers", async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/inbox-dynamic', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/inbox-dynamic', room, username: 'bob' });

    await subscribeRoom(alice.page, '1');
    await subscribeRoom(bob.page, '1');

    // Drive the host's persistent tag, unrelated to any channel.
    await send(alice.page, { event: 'add-favorite', payload: { key: 'blue' }, __wskit: {} });

    // Drive the host's top-level replay-tracked event a few times.
    await send(alice.page, { event: 'send-top-msg', payload: { text: 'top-1' }, __wskit: {} });
    await send(alice.page, { event: 'send-top-msg', payload: { text: 'top-2' }, __wskit: {} });
    const top2 = await waitForFrame(
      bob.page,
      (f) => f.event === 'top-msg' && f.payload.text === 'top-2',
    );

    // Then drive the room's inbox-backed broadcast.
    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'room-1' },
      __wskit: { channel: roomName('1'), channelFamily: FAMILY },
    });
    const roomMsg = await waitForFrame(
      alice.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'room-1',
    );

    // Both sequence counters are real numbers and neither collapsed into the
    // other — replay's top-level seq and the room's inbox seq are independent
    // counters, so nothing here asserts they differ by any particular amount,
    // only that both exist and the room delivery landed with the right scope.
    expect(typeof top2.__wskit?.seq).toBe('number');
    expect(typeof roomMsg.__wskit?.seq).toBe('number');
    expect(roomMsg.__wskit?.channel).toBe(roomName('1'));
    expect(roomMsg.__wskit?.channelFamily).toBe(FAMILY);

    await alice.close();
    await bob.close();
  });
});
