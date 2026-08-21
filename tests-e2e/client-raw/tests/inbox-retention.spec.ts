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

type RetentionAnswer = {
  rows: number;
  deliveredRows: number;
  watermarkRows: number;
  maxEvictedThrough: number | null;
};

async function probe(page: Parameters<typeof send>[0]): Promise<RetentionAnswer> {
  const already = (await frames(page)).filter((frame) => frame.event === 'retention-answer').length;
  await send(page, { event: 'probe-retention', payload: {}, __wskit: {} });
  await expect
    .poll(
      async () => (await frames(page)).filter((frame) => frame.event === 'retention-answer').length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(already);
  return (await frames(page)).filter((frame) => frame.event === 'retention-answer').at(-1)!
    .payload as unknown as RetentionAnswer;
}

test.describe('inbox retention (raw wire, real Cloudflare alarm)', () => {
  test('does not gap when count retention evicts only an acknowledged row', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, {
      path: '/inbox-retention',
      room,
      username: 'alice',
    });
    const bob = await openMember(browser, { path: '/inbox-retention', room, username: 'bob' });

    await subscribe(alice.page, 'count');
    await subscribe(bob.page, 'count');
    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'acknowledged-only' },
      __wskit: { channel: 'count' },
    });
    const acknowledged = await waitForFrame(
      alice.page,
      (frame) => frame.event === 'room-msg' && frame.payload.text === 'acknowledged-only',
    );
    const acknowledgedSeq = acknowledged.__wskit?.seq as number;
    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: acknowledgedSeq },
      __wskit: { channel: 'count' },
    });
    await alice.page.waitForTimeout(100);
    await closeSocket(alice.page);

    // The first two offline rows fill the cap alongside the retained,
    // acknowledged row. Inserting the second one evicts only that delivered
    // row, so there must be no overflow watermark or reconnect gap.
    for (const text of ['undelivered-1', 'undelivered-2']) {
      await send(bob.page, {
        event: 'send-room-msg',
        payload: { text },
        __wskit: { channel: 'count' },
      });
    }
    await bob.page.waitForTimeout(300);
    const queued = await probe(bob.page);
    expect(queued.rows).toBe(2);
    expect(queued.watermarkRows).toBe(0);

    await reconnect(alice.page);
    const surviving = await waitForFrame(
      alice.page,
      (frame) => frame.event === 'room-msg' && frame.payload.text === 'undelivered-2',
    );
    expect((await frames(alice.page)).some((frame) => frame.event === '__gap__')).toBe(false);

    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: surviving.__wskit?.seq },
      __wskit: { channel: 'count' },
    });
    await alice.page.waitForTimeout(100);
    await alice.close();
    await bob.close();
  });

  test('does not gap for acknowledged eviction, but gaps an evicted undelivered row', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, {
      path: '/inbox-retention',
      room,
      username: 'alice',
    });
    const bob = await openMember(browser, { path: '/inbox-retention', room, username: 'bob' });

    await subscribe(alice.page, 'count');
    await subscribe(bob.page, 'count');
    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'acknowledged' },
      __wskit: { channel: 'count' },
    });
    const acknowledged = await waitForFrame(
      alice.page,
      (frame) => frame.event === 'room-msg' && frame.payload.text === 'acknowledged',
    );
    const acknowledgedSeq = acknowledged.__wskit?.seq as number;
    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: acknowledgedSeq },
      __wskit: { channel: 'count' },
    });
    await alice.page.waitForTimeout(100);
    await closeSocket(alice.page);

    for (const text of ['undelivered-1', 'undelivered-2', 'undelivered-3']) {
      await send(bob.page, {
        event: 'send-room-msg',
        payload: { text },
        __wskit: { channel: 'count' },
      });
    }
    await bob.page.waitForTimeout(500);
    const queued = await probe(bob.page);
    expect(queued.rows).toBe(2);
    expect(queued.watermarkRows).toBe(1);

    await reconnect(alice.page);
    const gap = await waitForFrame(
      alice.page,
      (frame) => frame.event === '__gap__' && frame.__wskit?.channel === 'count',
    );
    const missedThrough = gap.payload.missedThrough as number;
    expect(missedThrough).toBeGreaterThan(acknowledgedSeq);
    expect(missedThrough).toBe(queued.maxEvictedThrough);
    const surviving = await waitForFrame(
      alice.page,
      (frame) => frame.event === 'room-msg' && frame.payload.text === 'undelivered-3',
    );
    expect(missedThrough).toBeLessThan(surviving.__wskit?.seq as number);
    expect(
      (await frames(alice.page)).some(
        (frame) => frame.event === 'room-msg' && frame.payload.text === 'acknowledged',
      ),
    ).toBe(false);
    expect(
      (await frames(alice.page)).some(
        (frame) => frame.event === 'room-msg' && frame.payload.text === 'undelivered-1',
      ),
    ).toBe(false);
    expect(
      (await frames(alice.page)).some(
        (frame) => frame.event === 'room-msg' && frame.payload.text === 'undelivered-2',
      ),
    ).toBe(true);

    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: surviving.__wskit?.seq },
      __wskit: { channel: 'count' },
    });
    await alice.page.waitForTimeout(100);
    await closeSocket(alice.page);
    await reconnect(alice.page);
    await alice.page.waitForTimeout(100);
    expect((await frames(alice.page)).some((frame) => frame.event === '__gap__')).toBe(false);

    await alice.close();
    await bob.close();
  });

  test('quiet expiry deletes the row, surfaces a gap, and leaves scheduled work alive', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, {
      path: '/inbox-retention',
      room,
      username: 'alice',
    });
    const bob = await openMember(browser, { path: '/inbox-retention', room, username: 'bob' });

    await subscribe(alice.page);
    await subscribe(bob.page);
    await closeSocket(alice.page);

    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'quiet-expiry' },
      __wskit: { channel: 'chat' },
    });
    const before = await probe(bob.page);
    expect(before.rows).toBe(1);
    expect(before.deliveredRows).toBe(0);
    expect(before.watermarkRows).toBe(0);

    // No channel traffic occurs while the held row ages. The top-level
    // recurring task is a separate alarm source and should still fire.
    await waitForFrame(bob.page, (frame) => frame.event === 'retention-heartbeat');
    await bob.page.waitForTimeout(1_200);

    const after = await probe(bob.page);
    expect(after.rows).toBe(0);
    expect(after.deliveredRows).toBe(0);
    expect(after.watermarkRows).toBe(1);
    expect(after.maxEvictedThrough).toBeGreaterThan(0);

    await reconnect(alice.page);
    const gap = await waitForFrame(
      alice.page,
      (frame) => frame.event === '__gap__' && frame.__wskit?.channel === 'chat',
    );
    const missedThrough = gap.payload.missedThrough as number;
    expect(missedThrough).toBe(after.maxEvictedThrough);

    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: missedThrough },
      __wskit: { channel: 'chat' },
    });
    await alice.page.waitForTimeout(100);
    await closeSocket(alice.page);
    await reconnect(alice.page);
    await alice.page.waitForTimeout(200);
    expect((await frames(alice.page)).filter((frame) => frame.event === '__gap__')).toHaveLength(0);

    await alice.close();
    await bob.close();
  });

  test('does not delete early, then ages out a delivered retained row', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, {
      path: '/inbox-retention',
      room,
      username: 'alice',
    });
    const bob = await openMember(browser, { path: '/inbox-retention', room, username: 'bob' });

    await subscribe(alice.page);
    await subscribe(bob.page);
    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'delivered-retained' },
      __wskit: { channel: 'chat' },
    });
    const message = await waitForFrame(
      alice.page,
      (frame) => frame.event === 'room-msg' && frame.payload.text === 'delivered-retained',
    );
    const seq = message.__wskit?.seq as number;

    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      __wskit: { channel: 'chat' },
    });
    await alice.page.waitForTimeout(100);

    const before = await probe(bob.page);
    expect(before.rows).toBe(1);
    expect(before.deliveredRows).toBe(1);
    expect(before.watermarkRows).toBe(0);

    await bob.page.waitForTimeout(1_400);
    const after = await probe(bob.page);
    expect(after.rows).toBe(0);
    expect(after.deliveredRows).toBe(0);
    expect(after.watermarkRows).toBe(0);

    await alice.close();
    await bob.close();
  });

  test('re-arms the age alarm from durable storage after a restart', async ({
    browser,
    request,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, {
      path: '/inbox-retention',
      room,
      username: 'alice',
    });
    const bob = await openMember(browser, { path: '/inbox-retention', room, username: 'bob' });

    await subscribe(alice.page);
    await subscribe(bob.page);
    await closeSocket(alice.page);
    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'restart-expiry' },
      __wskit: { channel: 'chat' },
    });
    expect((await probe(bob.page)).rows).toBe(1);

    const restart = await request.get(`/ws/inbox-retention/restart?room=${room}`);
    expect(restart.status()).toBe(204);
    await expect(bob.page.getByTestId('status')).toHaveText('disconnected');

    await reconnect(bob.page);
    await bob.page.waitForTimeout(1_400);
    const after = await probe(bob.page);
    expect(after.rows).toBe(0);
    expect(after.watermarkRows).toBe(1);

    await alice.close();
    await bob.close();
  });
});
