import { expect, test } from '@playwright/test';
import { frames, openMember, send, subscribe, waitForFrame } from './_inbox-rig.ts';

// Raw-wire conformance for received + read receipts against the real worker.
// `inbox` owns received: `__received__ {receivedThrough}` advances the received
// cursor, fans out as `__received__ {userId, receivedThrough}`, and answers
// `__receivedQuery__`. `readReceipts` owns read: `__read__ {readThrough}`
// advances the read cursor, fans out as `__read__ {userId, readThrough}`, and
// answers `__readQuery__`. `ask-cursor` returns the server's authoritative view.
// A non-member's `__read__` / query is dropped silently.

test.describe('receipts (raw wire, received + read cursors)', () => {
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

  test('a received ack fans out a __received__ with userId + receivedThrough', async ({
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

    // Alice (a member) sees bob's received fan-out (userId present).
    const fanout = await waitForFrame(
      alice.page,
      (f) =>
        f.event === '__received__' &&
        f.payload.userId === 'bob' &&
        f.payload.receivedThrough === seq,
    );
    expect(fanout.__wskit?.channel).toBe('chat');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('a read ack fans out a __read__ with userId + readThrough', async ({
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

    // Bob marks it read; the read cursor advances and fans out.
    await send(bob.page, {
      event: '__read__',
      payload: { readThrough: seq },
      __wskit: { channel: 'chat' },
    });

    const fanout = await waitForFrame(
      alice.page,
      (f) => f.event === '__read__' && f.payload.userId === 'bob' && f.payload.readThrough === seq,
    );
    expect(fanout.__wskit?.channel).toBe('chat');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('__receivedQuery__ / __readQuery__ round-trip userIds on their correlationId', async ({
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

    // Bob acks received and marks read so both cursors carry bob at seq.
    await send(bob.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      __wskit: { channel: 'chat' },
    });
    await send(bob.page, {
      event: '__read__',
      payload: { readThrough: seq },
      __wskit: { channel: 'chat' },
    });
    await bob.page.waitForTimeout(300);

    // receiversOf(seq): the reply echoes the correlationId and lists bob.
    await send(alice.page, {
      event: '__receivedQuery__',
      payload: { seq },
      __wskit: { channel: 'chat', correlationId: 'q-received-1' },
    });
    const receivedReply = await waitForFrame(
      alice.page,
      (f) => f.event === '__receivedQuery__' && f.__wskit?.correlationId === 'q-received-1',
    );
    expect(receivedReply.payload.userIds).toContain('bob');

    // readersOf(seq): a separate correlationId, likewise listing bob.
    await send(alice.page, {
      event: '__readQuery__',
      payload: { seq },
      __wskit: { channel: 'chat', correlationId: 'q-read-1' },
    });
    const readReply = await waitForFrame(
      alice.page,
      (f) => f.event === '__readQuery__' && f.__wskit?.correlationId === 'q-read-1',
    );
    expect(readReply.payload.userIds).toContain('bob');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('ask-cursor returns the server authoritative userIds', async ({ browser }, testInfo) => {
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

  test('a non-member __read__ / __readQuery__ is dropped (no fan-out, no reply)', async ({
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

    // A non-member's read ack must not fan out a __read__ to real members.
    await send(mallory.page, {
      event: '__read__',
      payload: { readThrough: seq },
      __wskit: { channel: 'chat' },
    });
    // A non-member's query gets no reply — it is dropped silently.
    await send(mallory.page, {
      event: '__readQuery__',
      payload: { seq },
      __wskit: { channel: 'chat', correlationId: 'mallory-q' },
    });

    await alice.page.waitForTimeout(800);
    await mallory.page.waitForTimeout(800);

    const malloryFanout = (await frames(alice.page)).filter(
      (f) => f.event === '__read__' && f.payload.userId === 'mallory',
    );
    expect(malloryFanout).toHaveLength(0);

    const malloryReply = (await frames(mallory.page)).filter(
      (f) => f.event === '__readQuery__' && f.__wskit?.correlationId === 'mallory-q',
    );
    expect(malloryReply).toHaveLength(0);

    await alice.close();
    await carol.close();
    await mallory.close();
  });
});
