import { expect, test } from '@playwright/test';
import { connect, frames, installRig, send, waitForFrame } from './_ws-rig.ts';

// Bind-parameter conformance for the durable inbox against the real Cloudflare
// worker. Inbox fan-out writes one durable row per offline member, and every row
// binds 8 parameters. Cloudflare Durable Objects cap one statement at 100 bound
// parameters, so an unbatched fan-out fails above 12 members — the live message
// still reaches everyone online, but every offline member silently loses their
// stored copy. Only a real worker can prove this: node:sqlite allows 32,766, so
// a unit test against it passes either way. That is exactly how this shipped.

const MEMBERS = 24; // Comfortably past the 12-member ceiling of one statement.

test.describe('inbox at scale (raw wire, real Durable Object)', () => {
  // Asserts the DURABLE side directly. A fan-out that throws is logged and the
  // live broadcast still proceeds, so every online member is served either way
  // and live frames alone prove nothing. `get-backlog` reports the rows actually
  // written, which is the thing the bind limit breaks.
  test('a broadcast writes a durable row for all 23 other members', async ({ page }, testInfo) => {
    test.slow();
    const room = `test-${testInfo.testId}`;
    await page.goto('/inbox-handle');
    await installRig(page);

    const ids: string[] = [];
    for (let i = 0; i < MEMBERS; i++) {
      ids.push(await connect(page, { path: '/ws/inbox-handle', username: `u${i}`, room }));
    }

    for (const id of ids) {
      await send(page, id, { event: '__subscribe__', payload: {}, __wskit: { channel: 'chat' } });
    }

    for (const id of ids) {
      await waitForFrame(page, id, {
        match: (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'chat',
      });
    }

    // One member broadcasts. The fan-out must write a durable row for all 23
    // others — 184 bound parameters, well past a single statement's budget.
    await send(page, ids[0]!, {
      event: 'send-room-msg',
      payload: { text: 'scale-hello' },
      __wskit: { channel: 'chat' },
    });

    for (const id of ids.slice(1)) {
      await waitForFrame(page, id, {
        match: (f) => f.event === 'room-msg' && f.payload?.text === 'scale-hello',
      });
    }

    // The durable rows are the real assertion. 23 members are owed one each —
    // 184 bound parameters, well past a single statement's budget of 100.
    await send(page, ids[0]!, { event: 'ask-backlog', payload: { channel: 'chat' } });
    const report = await waitForFrame(page, ids[0]!, {
      match: (f) => f.event === 'backlog-answer',
    });
    const entries = report.payload.entries as { userId: string }[];
    expect(entries).toHaveLength(MEMBERS - 1);

    // The sender is excluded from its own broadcast, live and durably.
    const senderFrames = await frames(page, ids[0]!);
    expect(senderFrames.filter((f) => f.event === 'room-msg')).toHaveLength(0);
    expect(entries.map((e) => e.userId)).not.toContain('u0');
  });

  // The same bind limit seen from the member's side, on the plain `inbox`
  // fixture: a row that was never written is a message the member never gets.
  test('a member offline during a 24-member broadcast still gets it on reconnect', async ({
    page,
  }, testInfo) => {
    test.slow();
    const room = `test-${testInfo.testId}`;
    await page.goto('/inbox');
    await installRig(page);

    const ids: string[] = [];
    for (let i = 0; i < MEMBERS; i++) {
      ids.push(await connect(page, { path: '/ws/inbox', username: `u${i}`, room }));
    }

    for (const id of ids) {
      await send(page, id, { event: '__subscribe__', payload: {}, __wskit: { channel: 'chat' } });
    }

    for (const id of ids) {
      await waitForFrame(page, id, {
        match: (f) => f.event === '__subscribeOk__' && f.__wskit?.channel === 'chat',
      });
    }

    // Drop one member, then broadcast while it is away. Its row is written by
    // the same batched fan-out; if a batch were lost, this member never learns
    // the message existed.
    const absentee = ids[MEMBERS - 1]!;
    await page.evaluate((sid) => window.__wskitClose!(sid), absentee);

    await send(page, ids[0]!, {
      event: 'send-room-msg',
      payload: { text: 'while-you-were-out' },
      __wskit: { channel: 'chat' },
    });

    // A member that stayed online proves the broadcast actually went out.
    await waitForFrame(page, ids[1]!, {
      match: (f) => f.event === 'room-msg' && f.payload?.text === 'while-you-were-out',
    });

    const rejoined = await connect(page, {
      path: '/ws/inbox',
      username: `u${MEMBERS - 1}`,
      room,
    });

    await waitForFrame(page, rejoined, {
      match: (f) => f.event === 'room-msg' && f.payload?.text === 'while-you-were-out',
    });
  });
});
