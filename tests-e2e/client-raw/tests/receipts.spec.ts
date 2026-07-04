import { expect, test } from '@playwright/test';
import { frames, openMember, send, subscribe, waitForFrame } from './_inbox-rig.ts';

// Raw-wire conformance for delivered + read receipts against the real worker.
// `inbox` owns delivered: `__received__` advances the received cursor and answers
// `receivedBy`. `readReceipts` owns read: `__seen__` advances the seen cursor and
// answers `seenBy`. Both fan out as `__receipt__` frames to members. A
// `__receiptQuery__` round-trips over its own correlationId. `ask-cursor` returns
// the server's authoritative view. A non-member's `__seen__` / `__receiptQuery__`
// is dropped silently.

test.describe('receipts (raw wire, delivered + seen cursors)', () => {
  test('__subscribeOk__ carries inbox:true and readReceipts:true', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/receipts', room, username: 'alice' });

    const ack = await subscribe(alice.page);
    expect(ack.__wskit?.inbox).toBe(true);
    expect(ack.__wskit?.readReceipts).toBe(true);

    await alice.close();
  });

  test('a delivered ack fans out a __receipt__ with receivedThrough', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/receipts', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/receipts', room, username: 'bob' });
    const carol = await openMember(browser, { path: '/receipts', room, username: 'carol' });

    await subscribe(alice.page);
    await subscribe(bob.page);
    await subscribe(carol.page);

    // Carol broadcasts; the channel excludes the sender, so alice and bob get it.
    await send(carol.page, {
      event: 'send-room-msg',
      payload: { text: 'hello' },
      __wskit: { channel: 'chat' },
    });
    const msg = await waitForFrame(
      bob.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'hello',
    );
    const seq = msg.__wskit?.seq as number;

    // Bob acks delivery; the received cursor advances and fans out to members.
    await send(bob.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      __wskit: { channel: 'chat' },
    });

    // Alice (a member) sees bob's delivered receipt.
    const receipt = await waitForFrame(
      alice.page,
      (f) =>
        f.event === '__receipt__' &&
        f.payload.identity === 'bob' &&
        f.payload.receivedThrough === seq,
    );
    expect(receipt.__wskit?.channel).toBe('chat');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('a seen ack fans out a __receipt__ with seenThrough', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/receipts', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/receipts', room, username: 'bob' });
    const carol = await openMember(browser, { path: '/receipts', room, username: 'carol' });

    await subscribe(alice.page);
    await subscribe(bob.page);
    await subscribe(carol.page);

    await send(carol.page, {
      event: 'send-room-msg',
      payload: { text: 'hello' },
      __wskit: { channel: 'chat' },
    });
    const msg = await waitForFrame(
      bob.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'hello',
    );
    const seq = msg.__wskit?.seq as number;

    // Bob marks it seen; the seen cursor advances and fans out.
    await send(bob.page, {
      event: '__seen__',
      payload: { seenThrough: seq },
      __wskit: { channel: 'chat' },
    });

    const receipt = await waitForFrame(
      alice.page,
      (f) =>
        f.event === '__receipt__' && f.payload.identity === 'bob' && f.payload.seenThrough === seq,
    );
    expect(receipt.__wskit?.channel).toBe('chat');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('__receiptQuery__ round-trips received and seen identities on its correlationId', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/receipts', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/receipts', room, username: 'bob' });
    const carol = await openMember(browser, { path: '/receipts', room, username: 'carol' });

    await subscribe(alice.page);
    await subscribe(bob.page);
    await subscribe(carol.page);

    await send(carol.page, {
      event: 'send-room-msg',
      payload: { text: 'hello' },
      __wskit: { channel: 'chat' },
    });
    const msg = await waitForFrame(
      bob.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'hello',
    );
    const seq = msg.__wskit?.seq as number;

    // Bob acks delivery and marks seen so both cursors carry bob at seq.
    await send(bob.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      __wskit: { channel: 'chat' },
    });
    await send(bob.page, {
      event: '__seen__',
      payload: { seenThrough: seq },
      __wskit: { channel: 'chat' },
    });
    await bob.page.waitForTimeout(300);

    // receivedBy(seq): the reply echoes the correlationId and lists bob.
    await send(alice.page, {
      event: '__receiptQuery__',
      payload: { seq, kind: 'received' },
      __wskit: { channel: 'chat', correlationId: 'q-received-1' },
    });
    const receivedReply = await waitForFrame(
      alice.page,
      (f) => f.event === '__receiptQuery__' && f.__wskit?.correlationId === 'q-received-1',
    );
    expect(receivedReply.payload.identities).toContain('bob');

    // seenBy(seq): a separate correlationId, likewise listing bob.
    await send(alice.page, {
      event: '__receiptQuery__',
      payload: { seq, kind: 'seen' },
      __wskit: { channel: 'chat', correlationId: 'q-seen-1' },
    });
    const seenReply = await waitForFrame(
      alice.page,
      (f) => f.event === '__receiptQuery__' && f.__wskit?.correlationId === 'q-seen-1',
    );
    expect(seenReply.payload.identities).toContain('bob');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('ask-cursor returns the server authoritative identities', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/receipts', room, username: 'alice' });
    const bob = await openMember(browser, { path: '/receipts', room, username: 'bob' });
    const carol = await openMember(browser, { path: '/receipts', room, username: 'carol' });

    await subscribe(alice.page);
    await subscribe(bob.page);
    await subscribe(carol.page);

    await send(carol.page, {
      event: 'send-room-msg',
      payload: { text: 'hello' },
      __wskit: { channel: 'chat' },
    });
    const msg = await waitForFrame(
      bob.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'hello',
    );
    const seq = msg.__wskit?.seq as number;

    await send(bob.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      __wskit: { channel: 'chat' },
    });
    await bob.page.waitForTimeout(300);

    // ask-cursor is a top-level app event; its answer comes back as cursor-answer.
    await send(alice.page, {
      event: 'ask-cursor',
      payload: { kind: 'received', seq },
      __wskit: { channel: 'chat' },
    });
    const answer = await waitForFrame(
      alice.page,
      (f) => f.event === 'cursor-answer' && f.payload.kind === 'received',
    );
    expect(answer.payload.seq).toBe(seq);
    expect(answer.payload.identities).toContain('bob');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('a non-member __seen__ / __receiptQuery__ is dropped (no fan-out, no reply)', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const alice = await openMember(browser, { path: '/receipts', room, username: 'alice' });
    const carol = await openMember(browser, { path: '/receipts', room, username: 'carol' });
    // Mallory connects to the same room but never subscribes to chat.
    const mallory = await openMember(browser, { path: '/receipts', room, username: 'mallory' });

    await subscribe(alice.page);
    await subscribe(carol.page);

    await send(carol.page, {
      event: 'send-room-msg',
      payload: { text: 'hello' },
      __wskit: { channel: 'chat' },
    });
    const msg = await waitForFrame(
      alice.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'hello',
    );
    const seq = msg.__wskit?.seq as number;

    // A non-member's seen ack must not fan out a __receipt__ to real members.
    await send(mallory.page, {
      event: '__seen__',
      payload: { seenThrough: seq },
      __wskit: { channel: 'chat' },
    });
    // A non-member's query gets no reply — it is dropped silently.
    await send(mallory.page, {
      event: '__receiptQuery__',
      payload: { seq, kind: 'seen' },
      __wskit: { channel: 'chat', correlationId: 'mallory-q' },
    });

    await alice.page.waitForTimeout(800);
    await mallory.page.waitForTimeout(800);

    const malloryReceipt = (await frames(alice.page)).filter(
      (f) => f.event === '__receipt__' && f.payload.identity === 'mallory',
    );
    expect(malloryReceipt).toHaveLength(0);

    const malloryReply = (await frames(mallory.page)).filter(
      (f) => f.event === '__receiptQuery__' && f.__wskit?.correlationId === 'mallory-q',
    );
    expect(malloryReply).toHaveLength(0);

    await alice.close();
    await carol.close();
    await mallory.close();
  });
});
