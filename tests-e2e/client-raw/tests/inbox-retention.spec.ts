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
  await send(page, { event: 'probe-retention', payload: {}, metadata: null });
  await expect
    .poll(
      async () => (await frames(page)).filter((frame) => frame.event === 'retention-answer').length,
      { timeout: 15_000 },
    )
    .toBeGreaterThan(already);
  return (await frames(page)).filter((frame) => frame.event === 'retention-answer').at(-1)!
    .payload as unknown as RetentionAnswer;
}

// probe-retention is a snapshot read: what it reports depends on other
// connections' acks/messages having already reached the durable object, and
// on retention alarms having fired. Resend it inside a retry instead of
// trusting a single fixed delay to have been enough.
// Retention here is 1s. An expired row must be gone well before this, so a
// deletion that runs far too late still fails the test.
const EXPIRY_TIMEOUT_MS = 4_000;

async function probeUntil(
  page: Parameters<typeof send>[0],
  check: (answer: RetentionAnswer) => void,
  timeout = 10_000,
): Promise<RetentionAnswer> {
  let answer!: RetentionAnswer;
  await expect(async () => {
    answer = await probe(page);
    check(answer);
  }).toPass({ timeout });
  return answer;
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
      metadata: { channel: { name: 'count' } },
    });
    const acknowledged = await waitForFrame(
      alice.page,
      (frame) => frame.event === 'room-msg' && frame.payload.text === 'acknowledged-only',
    );
    const acknowledgedSeq = acknowledged.metadata?.delivery?.seq as number;

    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: acknowledgedSeq },
      metadata: { channel: { name: 'count' } },
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
        metadata: { channel: { name: 'count' } },
      });
    }

    await probeUntil(bob.page, (a) => {
      expect(a.rows).toBe(2);
      expect(a.watermarkRows).toBe(0);
    });

    await reconnect(alice.page);
    const surviving = await waitForFrame(
      alice.page,
      (frame) => frame.event === 'room-msg' && frame.payload.text === 'undelivered-2',
    );
    expect((await frames(alice.page)).some((frame) => frame.event === '__gap__')).toBe(false);

    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: surviving.metadata?.delivery?.seq },
      metadata: { channel: { name: 'count' } },
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
      metadata: { channel: { name: 'count' } },
    });
    const acknowledged = await waitForFrame(
      alice.page,
      (frame) => frame.event === 'room-msg' && frame.payload.text === 'acknowledged',
    );
    const acknowledgedSeq = acknowledged.metadata?.delivery?.seq as number;

    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: acknowledgedSeq },
      metadata: { channel: { name: 'count' } },
    });
    await alice.page.waitForTimeout(100);
    await closeSocket(alice.page);

    for (const text of ['undelivered-1', 'undelivered-2', 'undelivered-3']) {
      await send(bob.page, {
        event: 'send-room-msg',
        payload: { text },
        metadata: { channel: { name: 'count' } },
      });
    }

    const queued = await probeUntil(bob.page, (a) => {
      expect(a.rows).toBe(2);
      expect(a.watermarkRows).toBe(1);
    });

    await reconnect(alice.page);
    const gap = await waitForFrame(
      alice.page,
      (frame) => frame.event === '__gap__' && frame.metadata?.channel?.name === 'count',
    );
    const missedThrough = gap.payload.missedThrough as number;
    expect(missedThrough).toBeGreaterThan(acknowledgedSeq);
    expect(missedThrough).toBe(queued.maxEvictedThrough);

    const surviving = await waitForFrame(
      alice.page,
      (frame) => frame.event === 'room-msg' && frame.payload.text === 'undelivered-3',
    );
    expect(missedThrough).toBeLessThan(surviving.metadata?.delivery?.seq as number);
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
      payload: { receivedThrough: surviving.metadata?.delivery?.seq },
      metadata: { channel: { name: 'count' } },
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
      metadata: { channel: { name: 'chat' } },
    });
    const before = await probe(bob.page);
    expect(before.rows).toBe(1);
    expect(before.deliveredRows).toBe(0);
    expect(before.watermarkRows).toBe(0);

    // No channel traffic occurs while the held row ages. The top-level
    // recurring task is a separate alarm source and should still fire.
    await waitForFrame(bob.page, (frame) => frame.event === 'retention-heartbeat');

    const after = await probeUntil(
      bob.page,
      (a) => {
        expect(a.rows).toBe(0);
        expect(a.deliveredRows).toBe(0);
        expect(a.watermarkRows).toBe(1);
      },
      EXPIRY_TIMEOUT_MS,
    );
    expect(after.maxEvictedThrough).toBeGreaterThan(0);

    await reconnect(alice.page);
    const gap = await waitForFrame(
      alice.page,
      (frame) => frame.event === '__gap__' && frame.metadata?.channel?.name === 'chat',
    );
    const missedThrough = gap.payload.missedThrough as number;
    expect(missedThrough).toBe(after.maxEvictedThrough);

    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: missedThrough },
      metadata: { channel: { name: 'chat' } },
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
      metadata: { channel: { name: 'chat' } },
    });
    const message = await waitForFrame(
      alice.page,
      (frame) => frame.event === 'room-msg' && frame.payload.text === 'delivered-retained',
    );
    const seq = message.metadata?.delivery?.seq as number;

    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      metadata: { channel: { name: 'chat' } },
    });
    // Bounded well under RETENTION_MS (1s) so this "not deleted early" check
    // cannot accidentally retry past the row's actual expiry.
    await probeUntil(
      bob.page,
      (a) => {
        expect(a.rows).toBe(1);
        expect(a.deliveredRows).toBe(1);
        expect(a.watermarkRows).toBe(0);
      },
      800,
    );

    await probeUntil(
      bob.page,
      (a) => {
        expect(a.rows).toBe(0);
        expect(a.deliveredRows).toBe(0);
        expect(a.watermarkRows).toBe(0);
      },
      EXPIRY_TIMEOUT_MS,
    );

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
      metadata: { channel: { name: 'chat' } },
    });
    expect((await probe(bob.page)).rows).toBe(1);

    const restart = await request.get(`/ws/inbox-retention/restart?room=${room}`);
    expect(restart.status()).toBe(204);
    await expect(bob.page.getByTestId('status')).toHaveText('disconnected');

    await reconnect(bob.page);
    await probeUntil(
      bob.page,
      (a) => {
        expect(a.rows).toBe(0);
        expect(a.watermarkRows).toBe(1);
      },
      EXPIRY_TIMEOUT_MS,
    );

    await alice.close();
    await bob.close();
  });
});
