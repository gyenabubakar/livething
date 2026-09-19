import { expect, test } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

// Pins the receipt frames' payload field names on the actual wire. The protocol
// schemas once declared `identity` / `identities` while the server sent and the
// client read `userId` / `userIds`. Nothing validates an outgoing payload at
// runtime, so the mismatch never broke a connection — it just made the declared
// protocol wrong, which is what a developer reads when debugging raw frames.
// Reading the field off a real frame is the only thing that can catch that.

test.describe('receipt frames on the wire (raw, real Durable Object)', () => {
  test('__received__ carries userId, never identity', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto('/receipts');
    await installRig(page);

    const alice = await connect(page, { path: '/ws/receipts', username: 'alice', room });
    const bob = await connect(page, { path: '/ws/receipts', username: 'bob', room });
    for (const id of [alice, bob]) {
      await send(page, id, {
        event: '__subscribe__',
        payload: null,
        metadata: { channel: { name: 'chat' } },
      });
      await waitForFrame(page, id, {
        match: (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === 'chat',
      });
    }

    await send(page, alice, {
      event: 'send-room-msg',
      payload: { text: 'ack-me' },
      metadata: { channel: { name: 'chat' } },
    });
    const delivered = await waitForFrame(page, bob, {
      match: (f) => f.event === 'room-msg' && f.payload?.text === 'ack-me',
    });

    const seq = delivered.metadata?.delivery?.seq as number;
    await send(page, bob, {
      event: '__received__',
      payload: { receivedThrough: seq },
      metadata: { channel: { name: 'chat' } },
    });

    // The fan-out reaches the other member.
    const tick = await waitForFrame(page, alice, { match: (f) => f.event === '__received__' });

    expect(Object.keys(tick.payload)).toContain('userId');
    expect(Object.keys(tick.payload)).not.toContain('identity');
    expect(tick.payload.userId).toBe('bob');
    expect(tick.payload.receivedThrough).toBe(seq);
  });

  test('a receipt query replies with userIds, never identities', async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto('/receipts');
    await installRig(page);

    const alice = await connect(page, { path: '/ws/receipts', username: 'alice', room });
    const bob = await connect(page, { path: '/ws/receipts', username: 'bob', room });
    for (const id of [alice, bob]) {
      await send(page, id, {
        event: '__subscribe__',
        payload: null,
        metadata: { channel: { name: 'chat' } },
      });
      await waitForFrame(page, id, {
        match: (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === 'chat',
      });
    }

    await send(page, alice, {
      event: 'send-room-msg',
      payload: { text: 'query-me' },
      metadata: { channel: { name: 'chat' } },
    });
    const delivered = await waitForFrame(page, bob, {
      match: (f) => f.event === 'room-msg' && f.payload?.text === 'query-me',
    });
    const seq = delivered.metadata?.delivery?.seq as number;

    await send(page, bob, {
      event: '__received__',
      payload: { receivedThrough: seq },
      metadata: { channel: { name: 'chat' } },
    });
    await waitForFrame(page, alice, { match: (f) => f.event === '__received__' });

    await send(page, alice, {
      event: '__receivedQuery__',
      payload: { seq },
      metadata: { exchange: { id: 'q1' }, channel: { name: 'chat' } },
    });
    const reply = await waitForFrame(page, alice, {
      match: (f) => f.event === '__receivedQuery__' && f.metadata?.exchange?.id === 'q1',
    });

    expect(Object.keys(reply.payload)).toContain('userIds');
    expect(Object.keys(reply.payload)).not.toContain('identities');
    expect(reply.payload.userIds).toContain('bob');

    // Receipt payloads expose user IDs with the same field names in every frame.
    const all = [...(await frames(page, alice)), ...(await frames(page, bob))];
    const stale = all.filter(
      (f) => 'identity' in (f.payload ?? {}) || 'identities' in (f.payload ?? {}),
    );
    expect(stale).toEqual([]);
  });
});
