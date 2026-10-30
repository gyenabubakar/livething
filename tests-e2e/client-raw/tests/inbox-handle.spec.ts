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
  await send(page, { event: 'ask-handle', payload: { channel, seq }, metadata: null });
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
  await send(page, { event: 'ask-backlog', payload: { channel }, metadata: null });
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
      metadata: { channel: { name: 'chat' } },
    });
    const msg = await waitForFrame(
      alice.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'hello',
    );
    const seq = msg.metadata?.delivery?.seq as number;

    await send(alice.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      metadata: { channel: { name: 'chat' } },
    });

    // Alice's ack is on a separate connection from bob's query, with no
    // ordering guarantee between them, so retry the query itself (askHandle
    // is designed to be called repeatedly — see the file-level comment)
    // instead of trusting a fixed delay for the ack to have landed first.
    let answer!: Awaited<ReturnType<typeof askHandle>>;
    await expect(async () => {
      answer = await askHandle(bob.page, 'chat', seq);
      expect(answer.payload.receiversOf).toEqual(['alice']);
    }).toPass({ timeout: 10_000 });
    expect(answer.payload.hasInbox).toBe(true);

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
      metadata: { channel: { name: 'chat' } },
    });
    const msg = await waitForFrame(
      bob.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'held-for-bob',
    );
    const seq = msg.metadata?.delivery?.seq as number;

    const before = await askBacklog(alice.page, 'chat');
    const entries = before.payload.entries as Array<Record<string, unknown>>;
    const bobEntry = entries.find((entry) => entry.userId === 'bob');
    expect(bobEntry).toBeDefined();
    expect(bobEntry?.online).toBe(true);

    expect(bobEntry?.heldRows).toBeGreaterThanOrEqual(1);
    expect(typeof bobEntry?.oldestHeldAt).toBe('number');
    expect(typeof bobEntry?.lastSeenAt).toBe('number');

    // Bob acks, which deletes his row.
    await send(bob.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      metadata: { channel: { name: 'chat' } },
    });

    // Bob's ack is on a separate connection from alice's query, with no
    // ordering guarantee between them, so retry the query itself (askBacklog
    // is designed to be called repeatedly — see the file-level comment)
    // instead of trusting a fixed delay for the ack to have landed first.
    await expect(async () => {
      const after = await askBacklog(alice.page, 'chat');
      const afterEntries = after.payload.entries as Array<Record<string, unknown>>;
      expect(afterEntries.find((entry) => entry.userId === 'bob')).toBeUndefined();
    }).toPass({ timeout: 10_000 });

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
      metadata: { channel: { name: 'chat' } },
    });

    // Bob's disconnect is on a separate connection from alice's broadcast and
    // query, with no ordering guarantee between them, so retry the query
    // itself (askBacklog is designed to be called repeatedly — see the
    // file-level comment) instead of trusting a fixed delay.
    let bobEntry: Record<string, unknown> | undefined;
    await expect(async () => {
      const answer = await askBacklog(alice.page, 'chat');
      const entries = answer.payload.entries as Array<Record<string, unknown>>;
      bobEntry = entries.find((entry) => entry.userId === 'bob');
      expect(bobEntry).toBeDefined();
      expect(bobEntry?.online).toBe(false);
    }).toPass({ timeout: 10_000 });

    await alice.close();
  });
});
