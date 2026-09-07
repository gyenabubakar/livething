import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closeSocket, frames, openMember, send, subscribe, waitForFrame } from './_inbox-rig.ts';
import type { Frame } from './_inbox-rig.ts';

// Raw-wire conformance for `ctx.channels.get(name).inbox()` — the channel-handle
// augmenter — and `inbox().backlog()`, against the real Cloudflare worker. `chat`
// has `inbox: true`; `plain` has no inbox config at all. `lastSeen()` is listed
// alongside `inbox()` so `backlog()` fills each member's `lastSeenAt`.
//
// `askHandle`/`askBacklog` may be called more than once for the same channel in
// one test (before/after an ack), so each one counts how many matching answers
// already sit in the frame log and waits for one more past that count — never
// re-matching a stale answer already seen.

async function askHandle(page: Page, channel: string, seq: number): Promise<Frame> {
  function match(f: Frame): boolean {
    return f.event === 'handle-answer' && f.payload.channel === channel;
  }

  const already = (await frames(page)).filter(match).length;
  await send(page, { event: 'ask-handle', payload: { channel, seq }, __wskit: {} });
  await expect
    .poll(async () => (await frames(page)).filter(match).length, { timeout: 15_000 })
    .toBeGreaterThan(already);

  return (await frames(page)).filter(match).at(-1)!;
}

async function askBacklog(page: Page, channel: string): Promise<Frame> {
  function match(f: Frame): boolean {
    return f.event === 'backlog-answer' && f.payload.channel === channel;
  }

  const already = (await frames(page)).filter(match).length;
  await send(page, { event: 'ask-backlog', payload: { channel }, __wskit: {} });
  await expect
    .poll(async () => (await frames(page)).filter(match).length, { timeout: 15_000 })
    .toBeGreaterThan(already);

  return (await frames(page)).filter(match).at(-1)!;
}

test.describe('ctx.channels.get(name).inbox() (raw wire, handle-augmenter)', () => {
  test('returns the inbox surface for an inbox channel, and null for a plain one', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/inbox-handle', room, username: 'alice' });

    // No subscription needed: the handle-augmenter works from any scope, gated
    // only on the channel's own `inbox` config, not on membership.
    const chatAnswer = await askHandle(alice.page, 'chat', 0);
    expect(chatAnswer.payload.hasInbox).toBe(true);
    expect(Array.isArray(chatAnswer.payload.receiversOf)).toBe(true);

    const plainAnswer = await askHandle(alice.page, 'plain', 0);
    expect(plainAnswer.payload.hasInbox).toBe(false);
    expect(plainAnswer.payload.receiversOf).toBeNull();

    await alice.close();
  });

  test('receiversOf reached through the handle reflects a real ack', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/inbox-handle', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/inbox-handle', room, username: 'bob' });

    await subscribe(alice.page);
    await subscribe(bob.page);

    // Bob broadcasts; alice (a live member) receives it with a seq.
    await send(bob.page, {
      event: 'send-room-msg',
      payload: { text: 'hello' },
      __wskit: { channel: 'chat' },
    });
    const msg = await waitForFrame(
      alice.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'hello',
    );
    const seq = msg.__wskit?.seq as number;

    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      __wskit: { channel: 'chat' },
    });
    // Give the ack time to settle before reading it back through the handle.
    await alice.page.waitForTimeout(300);

    const answer = await askHandle(bob.page, 'chat', seq);
    expect(answer.payload.hasInbox).toBe(true);
    expect(answer.payload.receiversOf).toEqual(['alice']);

    await alice.close();
    await bob.close();
  });
});

test.describe('inbox().backlog() (raw wire, via the handle-augmenter)', () => {
  test('lists an online member holding an unacked row, with lastSeenAt filled, then drops it after the ack', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/inbox-handle', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/inbox-handle', room, username: 'bob' });

    await subscribe(alice.page);
    await subscribe(bob.page);

    // Alice broadcasts; bob (a live member) receives it and holds an unacked row.
    await send(alice.page, {
      event: 'send-room-msg',
      payload: { text: 'held-for-bob' },
      __wskit: { channel: 'chat' },
    });
    const msg = await waitForFrame(
      bob.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'held-for-bob',
    );
    const seq = msg.__wskit?.seq as number;

    const before = await askBacklog(alice.page, 'chat');
    const entries = before.payload.entries as Array<Record<string, unknown>>;
    const bobEntry = entries.find((entry) => entry.userId === 'bob');
    expect(bobEntry).toBeDefined();
    expect(bobEntry?.online).toBe(true);

    expect(bobEntry?.heldRows).toBeGreaterThanOrEqual(1);
    expect(typeof bobEntry?.oldestHeldAt).toBe('number');
    expect(typeof bobEntry?.lastSeenAt).toBe('number');

    // Bob acks, settling (deleting, the default `onDelivered: 'delete'`) his row.
    await send(bob.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      __wskit: { channel: 'chat' },
    });
    await bob.page.waitForTimeout(300);

    const after = await askBacklog(alice.page, 'chat');
    const afterEntries = after.payload.entries as Array<Record<string, unknown>>;
    expect(afterEntries.find((entry) => entry.userId === 'bob')).toBeUndefined();

    await alice.close();
    await bob.close();
  });

  test('an offline member with a held row reports online: false', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/inbox-handle', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/inbox-handle', room, username: 'bob' });

    await subscribe(alice.page);
    await subscribe(bob.page);

    await closeSocket(bob.page);

    await send(alice.page, {
      event: 'send-room-msg',
      payload: { text: 'while-bob-offline' },
      __wskit: { channel: 'chat' },
    });
    await alice.page.waitForTimeout(300);

    const answer = await askBacklog(alice.page, 'chat');
    const entries = answer.payload.entries as Array<Record<string, unknown>>;
    const bobEntry = entries.find((entry) => entry.userId === 'bob');
    expect(bobEntry).toBeDefined();
    expect(bobEntry?.online).toBe(false);

    await alice.close();
  });
});
