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
    expect(ack.metadata?.channel?.inbox).toBe(true);
    expect(ack.metadata?.channel?.readReceipts).toBe(true);

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
      metadata: { channel: { name: 'chat' } },
    });
    const msg = await waitForFrame(
      bob.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'hello',
    );
    const seq = msg.metadata?.delivery?.seq as number;

    // Bob acks delivery; the received cursor advances and fans out to members.
    await send(bob.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      metadata: { channel: { name: 'chat' } },
    });

    // Alice (a member) sees bob's received fan-out (userId present).
    const fanout = await waitForFrame(
      alice.page,
      (f) =>
        f.event === '__received__' &&
        f.payload.userId === 'bob' &&
        f.payload.receivedThrough === seq,
    );
    expect(fanout.metadata?.channel?.name).toBe('chat');

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
      metadata: { channel: { name: 'chat' } },
    });
    const msg = await waitForFrame(
      bob.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'hello',
    );
    const seq = msg.metadata?.delivery?.seq as number;

    // Bob marks it read; the read cursor advances and fans out.
    await send(bob.page, {
      event: '__read__',
      payload: { readThrough: seq },
      metadata: { channel: { name: 'chat' } },
    });

    const fanout = await waitForFrame(
      alice.page,
      (f) => f.event === '__read__' && f.payload.userId === 'bob' && f.payload.readThrough === seq,
    );
    expect(fanout.metadata?.channel?.name).toBe('chat');

    await alice.close();
    await bob.close();
    await carol.close();
  });

  test('__receivedQuery__ / __readQuery__ return userIds with their metadata.exchange.id', async ({
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
      metadata: { channel: { name: 'chat' } },
    });
    const msg = await waitForFrame(
      bob.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'hello',
    );
    const seq = msg.metadata?.delivery?.seq as number;

    // Bob acks received and marks read so both cursors carry bob at seq.
    await send(bob.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      metadata: { channel: { name: 'chat' } },
    });
    await send(bob.page, {
      event: '__read__',
      payload: { readThrough: seq },
      metadata: { channel: { name: 'chat' } },
    });

    // Bob's acks are on a separate connection from alice's query, with no
    // ordering guarantee between them, so retry the query itself instead of
    // trusting a fixed delay for the acks to have landed first. A fresh
    // exchange id per attempt means a retry matches its own reply, not a
    // stale reply from an earlier attempt.
    // receiversOf(seq): the reply echoes `metadata.exchange.id` and lists bob.
    let receivedAttempt = 0;
    let receivedReply!: Awaited<ReturnType<typeof waitForFrame>>;
    await expect(async () => {
      const exchangeId = `q-received-${receivedAttempt++}`;
      await send(alice.page, {
        event: '__receivedQuery__',
        payload: { seq },
        metadata: { exchange: { id: exchangeId }, channel: { name: 'chat' } },
      });
      receivedReply = await waitForFrame(
        alice.page,
        (f) => f.event === '__receivedQuery__' && f.metadata?.exchange?.id === exchangeId,
      );
      expect(receivedReply.payload.userIds).toContain('bob');
    }).toPass({ timeout: 10_000 });

    // readersOf(seq): a separate exchange ID, likewise listing bob.
    let readAttempt = 0;
    let readReply!: Awaited<ReturnType<typeof waitForFrame>>;
    await expect(async () => {
      const exchangeId = `q-read-${readAttempt++}`;
      await send(alice.page, {
        event: '__readQuery__',
        payload: { seq },
        metadata: { exchange: { id: exchangeId }, channel: { name: 'chat' } },
      });
      readReply = await waitForFrame(
        alice.page,
        (f) => f.event === '__readQuery__' && f.metadata?.exchange?.id === exchangeId,
      );
      expect(readReply.payload.userIds).toContain('bob');
    }).toPass({ timeout: 10_000 });

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
      metadata: { channel: { name: 'chat' } },
    });
    const msg = await waitForFrame(
      bob.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'hello',
    );
    const seq = msg.metadata?.delivery?.seq as number;

    await send(bob.page, {
      event: '__received__',
      payload: { receivedThrough: seq },
      metadata: { channel: { name: 'chat' } },
    });

    // Bob's ack is on a separate connection from alice's query, with no
    // ordering guarantee between them, so retry the query itself instead of
    // trusting a fixed delay. Only frames after `before` are considered so a
    // retry matches its own fresh reply, not a stale one from an earlier
    // attempt.
    // ask-cursor is a top-level app event; its answer comes back as cursor-answer.
    let answer!: Awaited<ReturnType<typeof waitForFrame>>;
    await expect(async () => {
      const before = (await frames(alice.page)).length;
      await send(alice.page, {
        event: 'ask-cursor',
        payload: { kind: 'received', seq },
        metadata: { channel: { name: 'chat' } },
      });
      await expect
        .poll(
          async () =>
            (await frames(alice.page))
              .slice(before)
              .some((f) => f.event === 'cursor-answer' && f.payload.kind === 'received'),
          { timeout: 2_000 },
        )
        .toBe(true);
      answer = (await frames(alice.page))
        .slice(before)
        .find((f) => f.event === 'cursor-answer' && f.payload.kind === 'received')!;
      expect(answer.payload.identities).toContain('bob');
    }).toPass({ timeout: 10_000 });
    expect(answer.payload.seq).toBe(seq);

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
      metadata: { channel: { name: 'chat' } },
    });
    const msg = await waitForFrame(
      alice.page,
      (f) => f.event === 'room-msg' && f.payload.text === 'hello',
    );
    const seq = msg.metadata?.delivery?.seq as number;

    // A non-member's read ack must not fan out a __read__ to real members.
    await send(mallory.page, {
      event: '__read__',
      payload: { readThrough: seq },
      metadata: { channel: { name: 'chat' } },
    });
    // A non-member's query gets no reply — it is dropped silently.
    await send(mallory.page, {
      event: '__readQuery__',
      payload: { seq },
      metadata: { exchange: { id: 'mallory-q' }, channel: { name: 'chat' } },
    });

    await alice.page.waitForTimeout(800);
    await mallory.page.waitForTimeout(800);

    const malloryFanout = (await frames(alice.page)).filter(
      (f) => f.event === '__read__' && f.payload.userId === 'mallory',
    );
    expect(malloryFanout).toHaveLength(0);

    const malloryReply = (await frames(mallory.page)).filter(
      (f) => f.event === '__readQuery__' && f.metadata?.exchange?.id === 'mallory-q',
    );
    expect(malloryReply).toHaveLength(0);

    await alice.close();
    await carol.close();
    await mallory.close();
  });
});
