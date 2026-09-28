import { expect, test } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

// A channel broadcast excludes the sender by default, so a single-connection
// sender must not receive or store its own message. Otherwise that unacknowledged
// inbox row would be delivered on the next reconnect as if it were new.
//
// Exclusion is per connection; the inbox is per user. A sender with a second
// tab in the same channel DOES receive the live frame on that tab and acks it,
// so the row is still owed in that case. Both halves are covered here.

test.describe('inbox sender exclusion (raw wire, real Durable Object)', () => {
  test('a sender with one connection is not re-delivered its own message', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto('/inbox');
    await installRig(page);

    const alice = await connect(page, { path: '/ws/inbox', username: 'alice', room });
    const bob = await connect(page, { path: '/ws/inbox', username: 'bob', room });
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
      payload: { text: 'mine-only' },
      metadata: { channel: { name: 'chat' } },
    });

    // Bob receiving it proves the broadcast went out and the inbox write ran.
    await waitForFrame(page, bob, {
      match: (f) => f.event === 'room-msg' && f.payload?.text === 'mine-only',
    });

    await page.evaluate((sid) => window.__livethingClose!(sid), alice);
    const back = await connect(page, { path: '/ws/inbox', username: 'alice', room });

    // Give any owed drain time to arrive before asserting it did not.
    await page.waitForTimeout(1500);
    const drained = (await frames(page, back)).filter(
      (f) => f.event === 'room-msg' && f.payload?.text === 'mine-only',
    );
    expect(drained).toHaveLength(0);
  });

  test("a sender's second tab still receives and settles the message", async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto('/inbox');
    await installRig(page);

    // Two connections for the SAME user, plus a third member so the channel is
    // not just the sender.
    const tabA = await connect(page, { path: '/ws/inbox', username: 'alice', room });
    const tabB = await connect(page, { path: '/ws/inbox', username: 'alice', room });
    const bob = await connect(page, { path: '/ws/inbox', username: 'bob', room });
    for (const id of [tabA, tabB, bob]) {
      await send(page, id, {
        event: '__subscribe__',
        payload: null,
        metadata: { channel: { name: 'chat' } },
      });
      await waitForFrame(page, id, {
        match: (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === 'chat',
      });
    }

    await send(page, tabA, {
      event: 'send-room-msg',
      payload: { text: 'from-tab-a' },
      metadata: { channel: { name: 'chat' } },
    });

    // Only the sending connection is excluded, so alice's other tab gets it live.
    await waitForFrame(page, tabB, {
      match: (f) => f.event === 'room-msg' && f.payload?.text === 'from-tab-a',
    });
    const senderFrames = await frames(page, tabA);
    expect(senderFrames.filter((f) => f.payload?.text === 'from-tab-a')).toHaveLength(0);
  });
});
