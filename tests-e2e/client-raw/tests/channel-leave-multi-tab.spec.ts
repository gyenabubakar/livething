import { expect, test } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

// Durable channel membership and the inbox are stored per USER, but leaving a
// channel happens per CONNECTION. One tab calling unsubscribe used to delete
// the account's membership row and wipe its whole inbox, while another tab of
// the same user stayed subscribed and kept receiving live messages — then
// silently stopped auto-rejoining after a refresh, because the row it would
// have rejoined from was gone.
//
// The durable state must survive until the user's LAST connection leaves.

const CHANNEL = 'chat';

async function subscribed(page: Parameters<typeof connect>[0], id: string) {
  await send(page, id, { event: '__subscribe__', payload: {}, __wskit: { channel: CHANNEL } });
  await waitForFrame(page, id, {
    match: (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === CHANNEL,
  });
}

test.describe('per-user channel state across two tabs (raw wire, real DO)', () => {
  // Guards the opposite mistake from the one below. Making the durable row
  // survive is easy to over-correct into "a leave now waits for the last
  // connection", which would leave the leaving tab still receiving. Live
  // membership is per connection and must drop immediately; only the durable
  // row and inbox are per user. This test pins that half.
  test("one tab leaving does not cut off the user's other tab", async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto('/inbox');
    await installRig(page);

    const tabA = await connect(page, { path: '/ws/inbox', username: 'alice', room });
    const tabB = await connect(page, { path: '/ws/inbox', username: 'alice', room });
    const bob = await connect(page, { path: '/ws/inbox', username: 'bob', room });
    for (const id of [tabA, tabB, bob]) await subscribed(page, id);

    // Tab A leaves. Tab B is still a member.
    await send(page, tabA, {
      event: '__unsubscribe__',
      payload: {},
      __wskit: { channel: CHANNEL, unsubscribeId: 'u1' },
    });
    await waitForFrame(page, tabA, { match: (f) => f.event === '__unsubscribeOk__' });

    await send(page, bob, {
      event: 'send-room-msg',
      payload: { text: 'after-one-tab-left' },
      __wskit: { channel: CHANNEL },
    });

    // Tab B must still receive.
    await waitForFrame(page, tabB, {
      match: (f) => f.event === 'room-msg' && f.payload?.text === 'after-one-tab-left',
    });

    // Tab A left, so it must not.
    const aFrames = await frames(page, tabA);
    expect(
      aFrames.filter((f) => f.event === 'room-msg' && f.payload?.text === 'after-one-tab-left'),
    ).toHaveLength(0);
  });

  // THE guard. Reverting the last-connection check makes this fail: the row is
  // gone, so the reconnect never auto-rejoins.
  test('durable membership survives one tab leaving and is dropped after the last', async ({
    page,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto('/inbox');
    await installRig(page);

    const tabA = await connect(page, { path: '/ws/inbox', username: 'alice', room });
    const tabB = await connect(page, { path: '/ws/inbox', username: 'alice', room });
    for (const id of [tabA, tabB]) await subscribed(page, id);

    await send(page, tabA, {
      event: '__unsubscribe__',
      payload: {},
      __wskit: { channel: CHANNEL, unsubscribeId: 'u1' },
    });
    await waitForFrame(page, tabA, { match: (f) => f.event === '__unsubscribeOk__' });

    // Drop tab B without unsubscribing, then reconnect. The durable row must
    // still exist, so persistence auto-rejoins the channel with no __subscribe__.
    await page.evaluate((sid) => window.__wskitClose!(sid), tabB);
    const rejoined = await connect(page, { path: '/ws/inbox', username: 'alice', room });
    await waitForFrame(page, rejoined, {
      match: (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === CHANNEL,
    });
  });
});
