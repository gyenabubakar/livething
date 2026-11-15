import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('channel-static', () => {
  async function openPage(page: Page, room: string, username = 'testuser') {
    await page.goto(`/channel-static?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('_subscribe joins the channel and sends _subscribeOk', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('1');
  });

  test('a second _subscribe for an existing member is a no-op (no extra ack)', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('1');

    // The server trusts no client: a duplicate __subscribe__ for a channel it is
    // already a member of must be answered with nothing. Subscribing to a second
    // channel right after proves it — frames are ordered, so a stray ack for the
    // duplicate would have to arrive before room2's. The count goes straight to 2.
    await page.getByTestId('subscribe-room').click();
    await page.getByTestId('subscribe-room2').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('2');
    await expect(page.getByTestId('subscribe-ok-channels')).toHaveText('room,room2');
  });

  test('subscribing to an unknown channel emits _error with code channel-not-found', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-bogus').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText(
      'does-not-exist:channel-not-found',
    );
  });

  test('__subscribe__ with non-string channel emits __error__ without forwarding the bad field', async ({
    page,
  }, testInfo) => {
    // A buggy or hostile client might send `channel: 42`. The error
    // frame the server sends back must not carry that number on its
    // routing fields — the wire contract on `channel` is "string only".
    await openPage(page, `test-${testInfo.testId}`);

    const errors = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      const got: {
        event: string;
        payload: Record<string, unknown>;
        metadata?: Record<string, Record<string, unknown>> | null;
      }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') got.push(window.__livethingDecode(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };

      ws.send(
        window.__livethingEncode({
          event: '__subscribe__',
          payload: null,
          metadata: { channel: { name: 42, family: { evil: true } } },
        }),
      );
      await new Promise((r) => setTimeout(r, 300));
      ws.onmessage = original;

      return got.filter((m) => m.event === '__error__');
    });

    expect(errors.length).toBeGreaterThan(0);
    const err = errors[0]!;
    // The error reaches the client. Routing fields are stripped because
    // the inputs were not strings.
    expect(err.metadata?.channel?.name).toBeUndefined();
    expect(err.metadata?.channel?.family).toBeUndefined();
  });

  test('_unsubscribe when not subscribed emits _error channel-not-subscribed', async ({
    page,
  }, testInfo) => {
    // The raw driver sends `__unsubscribe__` with no `unsubscribeId`. A leave with
    // no id for a non-member gets this error — only id-bearing leaves (which
    // the reliable client always sends) are idempotently re-acked.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('unsubscribe-room').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText('room:channel-not-subscribed');

    // Positive signal that the connection remains healthy after the protocol error.
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('1');
  });

  test('publishing to a channel without subscribing first emits _error', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    // Bob subscribes; alice does not. Alice tries to publish unsubscribed.
    await b.getByTestId('subscribe-room').click();
    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    await a.getByTestId('publish-without-sub').click();
    await expect(a.getByTestId('subscribe-error')).toHaveText('room:channel-not-subscribed');

    // Now alice subscribes and publishes a second time — bob should receive
    // only the subscribed publish.
    await a.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');
    await a.getByTestId('send-hello').click();

    await expect(b.getByTestId('user-messages')).toContainText('alice:hello');
    await expect(b.getByTestId('user-messages')).not.toContainText('alice:stray');

    await ctxA.close();
    await ctxB.close();
  });

  test('check rejection emits _error and prevents the subscription', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`, 'blocked-user');
    await page.getByTestId('subscribe-room').click();
    // The thrown error in check is routed back as an _error frame —
    // that's our positive signal. Then assert no _subscribeOk.
    await expect(page.getByTestId('subscribe-error')).toContainText('room:');
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('0');
  });

  test('ctx.channel.broadcast reaches every subscribed member', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');

    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    // ctx.channel.broadcast fans out to OTHER members; sender does not
    // receive their own broadcast. Peer-round-trip proves delivery without a
    // fixed timeout: if alice's own broadcast were going to echo back, it
    // would arrive before bob's subsequent broadcast does.
    await a.getByTestId('send-hello').click();
    await expect(b.getByTestId('user-messages')).toContainText('alice:hello');
    await b.getByTestId('send-hello').click();
    await expect(a.getByTestId('user-messages')).toContainText('bob:hello');
    await expect(a.getByTestId('user-messages')).not.toContainText('alice:hello');

    await ctxA.close();
    await ctxB.close();
  });

  test('onSubscribe broadcasts a system message to existing members', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await openPage(a, room, 'alice');
    await a.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');

    // Bob joining triggers onSubscribe which broadcasts "bob entered" to alice.
    await openPage(b, room, 'bob');
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('system-messages')).toContainText('bob entered');

    await ctxA.close();
    await ctxB.close();
  });

  test('onUnsubscribe broadcasts a system message to remaining members', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');

    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    await b.getByTestId('unsubscribe-room').click();
    await expect(a.getByTestId('system-messages')).toContainText('bob left');

    await ctxA.close();
    await ctxB.close();
  });

  test('stream declared inside a channel yields chunks and ends normally', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('subscribe-room').click();
    await expect(page.getByTestId('subscribe-ok-count')).toHaveText('1');
    await page.getByTestId('start-channel-stream-3').click();
    await expect(page.getByTestId('channel-stream-chunks')).toHaveText('0,1,2');

    await expect(page.getByTestId('channel-stream-end')).toHaveText('yes');
  });

  test('a join change is delivered when a peer subscribes', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await openPage(a, room, 'alice');
    await a.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');

    await openPage(b, room, 'bob');
    await b.getByTestId('subscribe-room').click();

    // Alice (existing member) should see the join change
    // referencing bob's connection on the 'room' channel.
    await expect(a.getByTestId('member-joins')).toContainText('room:');

    await ctxA.close();
    await ctxB.close();
  });

  test('joining client receives _subscribeOk before existing member observes the join change', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await openPage(a, room, 'alice');
    await a.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');

    await openPage(b, room, 'bob');
    await b.getByTestId('subscribe-room').click();

    // Bob (the joining client) must receive _subscribeOk before we check Alice's side.
    // This assertion waits for Bob's ack to arrive, confirming the server sent it first.
    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');
    // Only now verify that Alice (existing member) observed the join change.
    await expect(a.getByTestId('member-joins')).toContainText('room:');

    await ctxA.close();
    await ctxB.close();
  });

  test('a leave change is delivered on manual _unsubscribe', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');

    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    await b.getByTestId('unsubscribe-room').click();
    await expect(a.getByTestId('member-leaves')).toContainText('room:');

    await ctxA.close();
    await ctxB.close();
  });

  test(
    'a leave change is delivered on connection drop',
    { tag: '@drop' },
    async ({ browser }, testInfo) => {
      const room = `test-${testInfo.testId}`;
      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();

      await openPage(a, room, 'alice');
      await openPage(b, room, 'bob');
      await a.getByTestId('subscribe-room').click();
      await b.getByTestId('subscribe-room').click();
      await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');

      await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

      await ctxB.close();
      await expect(a.getByTestId('member-leaves')).toContainText('room:', { timeout: 15_000 });

      await ctxA.close();
    },
  );

  test(
    'connection drop (not manual unsubscribe) still fires onUnsubscribe',
    { tag: '@drop' },
    async ({ browser }, testInfo) => {
      const room = `test-${testInfo.testId}`;
      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();
      const a = await ctxA.newPage();
      const b = await ctxB.newPage();

      await openPage(a, room, 'alice');
      await openPage(b, room, 'bob');
      await a.getByTestId('subscribe-room').click();
      await b.getByTestId('subscribe-room').click();
      await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');

      await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

      // Close bob's connection without explicit unsubscribe
      await ctxB.close();

      // Alice should still see bob's "left" system message
      await expect(a.getByTestId('system-messages')).toContainText('bob left', { timeout: 15_000 });

      await ctxA.close();
    },
  );

  test(
    'peer still receives a leave change on a second channel when the first channel onUnsubscribe throws',
    { tag: '@drop' },
    async ({ browser }, testInfo) => {
      // A throwing onUnsubscribe is contained to its membership so cleanup and
      // leave notifications continue for the connection's other channels.
      const room = `test-${testInfo.testId}-throwing-unsubscribe`;
      const ctxThrower = await browser.newContext();
      const ctxObserver = await browser.newContext();
      const thrower = await ctxThrower.newPage();
      const observer = await ctxObserver.newPage();

      // 'leave-thrower' triggers the throwing onUnsubscribe hook on `room`.
      await openPage(thrower, room, 'leave-thrower');
      await openPage(observer, room, 'observer');

      // Thrower joins both `room` (throwing onUnsubscribe) and `room2`.
      await thrower.getByTestId('subscribe-room').click();
      await thrower.getByTestId('subscribe-room2').click();
      await expect(thrower.getByTestId('subscribe-ok-count')).toHaveText('2');

      // Observer joins ONLY `room2` so the test pins that the second
      // channel's leave fan-out fired despite the first channel throwing.
      await observer.getByTestId('subscribe-room2').click();
      await expect(observer.getByTestId('subscribe-ok-count')).toHaveText('1');

      await ctxThrower.close();

      // Observer must receive a leave change for `room2` even though the
      // first channel's onUnsubscribe threw.
      await expect(observer.getByTestId('member-leaves')).toContainText('room2:', {
        timeout: 15_000,
      });

      await ctxObserver.close();
    },
  );

  test(
    'peer still receives a leave change when the leaver onDisconnect hook throws',
    { tag: '@drop' },
    async ({ browser }, testInfo) => {
      // A throwing onDisconnect is contained so channel memberships are released
      // and peers still receive the leave notification.
      const room = `test-${testInfo.testId}-throwing-disconnect`;
      const ctxThrower = await browser.newContext();
      const ctxObserver = await browser.newContext();
      const thrower = await ctxThrower.newPage();
      const observer = await ctxObserver.newPage();

      // The 'throwing-user' username triggers the throwing onDisconnect hook
      // wired in the channel-static fixture.
      await openPage(thrower, room, 'throwing-user');
      await openPage(observer, room, 'observer');
      await thrower.getByTestId('subscribe-room').click();
      await observer.getByTestId('subscribe-room').click();
      await expect(thrower.getByTestId('subscribe-ok-count')).toHaveText('1');

      await expect(observer.getByTestId('subscribe-ok-count')).toHaveText('1');

      await ctxThrower.close();

      // The observer must receive the leave broadcast from the channel
      // onUnsubscribe hook even though the top-level onDisconnect threw.
      await expect(observer.getByTestId('system-messages')).toContainText('throwing-user left', {
        timeout: 15_000,
      });
      await expect(observer.getByTestId('member-leaves')).toContainText('room:', {
        timeout: 15_000,
      });

      await ctxObserver.close();
    },
  );

  test('throwing onSubscribe still confirms the subscribe; the throw becomes an observational _error scoped to the channel', async ({
    browser,
  }, testInfo) => {
    // The subscribe confirmation is sent before the observational onSubscribe
    // hook runs. If that hook throws, the client keeps the successful
    // subscription and receives a separate channel-scoped error.
    const room = `test-${testInfo.testId}-onsubscribe-throw`;
    const ctxThrower = await browser.newContext();
    const ctxObserver = await browser.newContext();
    const thrower = await ctxThrower.newPage();
    const observer = await ctxObserver.newPage();

    // 'subscribe-thrower' username triggers the throwing onSubscribe in
    // the channel-static fixture.
    await openPage(thrower, room, 'subscribe-thrower');
    await openPage(observer, room, 'observer');

    await thrower.getByTestId('subscribe-room').click();
    // The subscribe was committed — _subscribeOk reached the client.
    await expect(thrower.getByTestId('subscribe-ok-count')).toHaveText('1');
    // The observational error reached the client with the channel code.
    await expect(thrower.getByTestId('subscribe-error')).toHaveText('room:internal-error');

    // Membership is real on the server: the observer subscribes and
    // sends a message; the thrower (still in the channel) receives it.
    await observer.getByTestId('subscribe-room').click();
    await expect(observer.getByTestId('subscribe-ok-count')).toHaveText('1');
    await observer.getByTestId('send-hello').click();
    await expect(thrower.getByTestId('user-messages')).toContainText('observer:hello', {
      timeout: 5_000,
    });

    await ctxThrower.close();
    await ctxObserver.close();
  });

  test('ctx.channel.broadcast survives a non-serializable payload and keeps the connection healthy', async ({
    browser,
  }, testInfo) => {
    // A serialization failure is logged and contained inside the broadcast.
    // It does not send an error to the triggering client or break later sends.
    const room = `test-${testInfo.testId}-bad-broadcast`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');

    await a.getByTestId('subscribe-room').click();
    await b.getByTestId('subscribe-room').click();
    await expect(a.getByTestId('subscribe-ok-count')).toHaveText('1');
    await expect(b.getByTestId('subscribe-ok-count')).toHaveText('1');

    // Trigger the bad broadcast from alice. The handler calls
    // ctx.channel.broadcast with a BigInt-bearing payload.
    await a.getByTestId('trigger-bad-broadcast').click();

    // The triggering client must NOT receive an _error for the channel —
    // the broadcast contained the failure internally. Give the network
    // a beat to confirm nothing came back, then assert empty.
    await a.waitForTimeout(500);
    await expect(a.getByTestId('bad-broadcast-error-code')).toHaveText('');

    // Both connections remain healthy, so a later valid message still arrives.
    await a.getByTestId('send-hello').click();
    await expect(b.getByTestId('user-messages')).toContainText('alice:hello', { timeout: 5_000 });

    await ctxA.close();
    await ctxB.close();
  });

  test('kick across multiple throwing onUnsubscribe hooks kicks everyone, then rejects with every hook failure', async ({
    page,
  }, testInfo) => {
    const room = `kick-multi-throw-${testInfo.testId}`;
    await page.goto(`/channel-static?room=${room}`);

    const handle = await page.evaluateHandle(
      async ({ room }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        function open(username: string): Promise<{
          ws: WebSocket;
          messages: {
            event: string;
            payload: Record<string, unknown>;
            metadata?: Record<string, Record<string, unknown>> | null;
          }[];
        }> {
          return new Promise((resolve, reject) => {
            const ws = new WebSocket(
              `${proto}//${location.host}/ws/channel-static?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
            );
            const messages: {
              event: string;
              payload: Record<string, unknown>;
              metadata?: Record<string, Record<string, unknown>> | null;
            }[] = [];
            ws.onmessage = (ev) => {
              if (typeof ev.data !== 'string') return;

              messages.push(window.__livethingDecode(ev.data));
            };
            ws.onopen = () => resolve({ ws, messages });
            ws.onerror = (e) => reject(e);
          });
        }

        const thrower_a = await open('leave-thrower-a');
        const thrower_b = await open('leave-thrower-b');
        const observer = await open('observer');

        return { thrower_a, thrower_b, observer };
      },
      { room },
    );

    await page.evaluate(
      ({ h }) => {
        const handles = h as unknown as Record<string, { ws: WebSocket }>;
        const subscribe = {
          event: '__subscribe__',
          payload: null,
          metadata: { channel: { name: 'room' } },
        };

        handles.thrower_a!.ws.send(window.__livethingEncode(subscribe));
        handles.thrower_b!.ws.send(window.__livethingEncode(subscribe));
        handles.observer!.ws.send(window.__livethingEncode(subscribe));
      },
      { h: handle },
    );

    async function countEvents(name: 'thrower_a' | 'thrower_b' | 'observer', event: string) {
      return page.evaluate(
        ({ h, name, event }) => {
          const handles = h as unknown as Record<
            string,
            {
              messages: {
                event: string;
                payload: Record<string, unknown>;
                metadata?: Record<string, Record<string, unknown>> | null;
              }[];
            }
          >;
          return handles[name]!.messages.filter((m) => m.event === event).length;
        },
        { h: handle, name, event },
      );
    }

    async function countLeaveChanges(name: 'observer') {
      return page.evaluate(
        ({ h, name }) => {
          const handles = h as unknown as Record<
            string,
            { messages: { event: string; payload: Record<string, unknown> }[] }
          >;
          return handles[name]!.messages.filter((m) => m.event === '__memberChanges__')
            .flatMap((m) => m.payload.changes as { kind: string }[])
            .filter((change) => change.kind === 'leave').length;
        },
        { h: handle, name },
      );
    }

    await expect
      .poll(
        async () =>
          (await countEvents('thrower_a', '__subscribeOk__')) +
          (await countEvents('thrower_b', '__subscribeOk__')) +
          (await countEvents('observer', '__subscribeOk__')),
      )
      .toBe(3);

    await page.evaluate(
      ({ h }) => {
        const handles = h as unknown as Record<string, { ws: WebSocket }>;
        const tag = { event: 'tag-self', payload: { tag: 'troll' } };
        handles.thrower_a!.ws.send(window.__livethingEncode(tag));
        handles.thrower_b!.ws.send(window.__livethingEncode(tag));
      },
      { h: handle },
    );

    await expect
      .poll(
        async () =>
          (await countEvents('thrower_a', 'tag-ack')) + (await countEvents('thrower_b', 'tag-ack')),
      )
      .toBe(2);

    await page.evaluate(
      ({ h }) => {
        const handles = h as unknown as Record<string, { ws: WebSocket }>;
        handles.observer!.ws.send(
          window.__livethingEncode({
            event: 'kick-by-tag',
            payload: { tag: 'troll', reason: 'spam' },
          }),
        );
      },
      { h: handle },
    );

    await expect.poll(async () => countEvents('observer', 'kick-failed')).toBe(1);
    await expect.poll(async () => countLeaveChanges('observer')).toBe(2);
    expect(await countEvents('observer', 'kick-ack')).toBe(0);
    expect(await countEvents('thrower_a', '__kicked__')).toBe(1);
    expect(await countEvents('thrower_b', '__kicked__')).toBe(1);

    const failure = await page.evaluate(
      ({ h }) => {
        const handles = h as unknown as Record<
          string,
          { messages: { event: string; payload: Record<string, unknown> }[] }
        >;
        return handles.observer!.messages.find((m) => m.event === 'kick-failed')?.payload;
      },
      { h: handle },
    );
    expect(failure).toEqual({ tag: 'troll', failures: 2 });

    const observerErrors = await page.evaluate(
      ({ h }) => {
        const handles = h as unknown as Record<
          string,
          {
            messages: {
              event: string;
              payload: Record<string, unknown>;
              metadata?: Record<string, Record<string, unknown>> | null;
            }[];
          }
        >;
        return handles.observer!.messages.filter(
          (m) => m.event === '__error__' && !m.metadata?.channel?.name,
        ).length;
      },
      { h: handle },
    );
    expect(observerErrors).toBe(0);

    await page.evaluate(
      ({ h }) => {
        const handles = h as unknown as Record<string, { ws: WebSocket }>;
        handles.thrower_a!.ws.close();
        handles.thrower_b!.ws.close();
        handles.observer!.ws.close();
      },
      { h: handle },
    );
  });

  test('channelHandle.subscribe(ctx.connection) commits the membership and sends _subscribeOk with source server', async ({
    page,
  }, testInfo) => {
    // Pins the server-initiated subscribe path (issue #11). The handler
    // runs ctx.channels.get('room2').subscribe(ctx.connection) in response to a
    // trigger event from the client. The client receives _subscribeOk for
    // room2 carrying `source: 'server'` — the marker the client SDK uses
    // to tell server-initiated subscribes apart from its own.
    await openPage(page, `test-${testInfo.testId}`);

    const captured = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      const got: {
        event: string;
        payload: Record<string, unknown>;
        metadata?: Record<string, Record<string, unknown>> | null;
      }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') got.push(window.__livethingDecode(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };

      ws.send(window.__livethingEncode({ event: 'trigger-server-subscribe', payload: {} }));

      // Wait until the __subscribeOk__ for room2 has arrived (or time out).
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (
          got.some((m) => m.event === '__subscribeOk__' && m.metadata?.channel?.name === 'room2')
        ) {
          break;
        }

        await new Promise((r) => setTimeout(r, 20));
      }

      return got;
    });

    const subscribeOk = captured.find(
      (m) => m.event === '__subscribeOk__' && m.metadata?.channel?.name === 'room2',
    );
    expect(subscribeOk).toBeDefined();
    expect(subscribeOk!.metadata?.exchange?.source).toBe('server');
  });

  test('a second channelHandle.subscribe for an already-subscribed connection is a no-op', async ({
    page,
  }, testInfo) => {
    // Server-side subscribe semantics — calling subscribe on a connection
    // that is already a member of the channel resolves immediately and
    // does NOT emit a second _subscribeOk or another join change.
    await openPage(page, `test-${testInfo.testId}`);

    const counts = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      const got: {
        event: string;
        payload: Record<string, unknown>;
        metadata?: Record<string, Record<string, unknown>> | null;
      }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') got.push(window.__livethingDecode(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };

      ws.send(window.__livethingEncode({ event: 'trigger-server-subscribe', payload: {} }));
      ws.send(window.__livethingEncode({ event: 'trigger-server-subscribe', payload: {} }));

      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const okCount = got.filter(
          (m) => m.event === '__subscribeOk__' && m.metadata?.channel?.name === 'room2',
        ).length;
        if (okCount >= 1) await new Promise((r) => setTimeout(r, 200));
        if (Date.now() >= deadline - 200) break;

        await new Promise((r) => setTimeout(r, 20));
      }

      return {
        subscribeOks: got.filter(
          (m) => m.event === '__subscribeOk__' && m.metadata?.channel?.name === 'room2',
        ).length,
        memberJoins: got
          .filter((m) => m.event === '__memberChanges__' && m.metadata?.channel?.name === 'room2')
          .flatMap((m) => m.payload.changes as { kind: string }[])
          .filter((change) => change.kind === 'join').length,
      };
    });

    expect(counts.subscribeOks).toBe(1);
    // No prior member in room2 to sync, and the second trigger no-ops, so
    // zero join changes reach this connection for room2.
    expect(counts.memberJoins).toBe(0);
  });

  test('a connection subscribed via channelHandle.subscribe receives subsequent room2 broadcasts', async ({
    browser,
  }, testInfo) => {
    // The wire `_subscribeOk` confirms intent. This test confirms the real
    // membership: a peer broadcasts into room2 and the server-side-subscribed
    // connection receives the room-message. If the engine had stamped the
    // _subscribeOk frame but skipped the addChannelMembership call, this
    // test would fail.
    const sharedRoom = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await openPage(pageA, sharedRoom, 'alice');
    await openPage(pageB, sharedRoom, 'bob');

    // alice triggers a server-side subscribe to room2.
    await pageA.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(window.__livethingEncode({ event: 'trigger-server-subscribe', payload: {} }));
    });

    // bob subscribes to room2 the normal way (client _subscribe), so he can
    // send a broadcast into it.
    await pageB.getByTestId('subscribe-room2').click();
    await expect(pageB.getByTestId('subscribe-ok-count')).toHaveText('1');

    // alice starts capturing frames before bob broadcasts.
    const aliceCaptureSetup = pageA.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      const captured: {
        event: string;
        payload: Record<string, unknown>;
        metadata?: Record<string, Record<string, unknown>> | null;
      }[] = [];
      (window as unknown as { __capture?: typeof captured }).__capture = captured;
      const original = ws.onmessage;

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') captured.push(window.__livethingDecode(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };
    });
    await aliceCaptureSetup;

    // bob broadcasts into room2. Routing markers live in `metadata`; the
    // engine routes on them and `payload` carries only the event data.
    await pageB.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        window.__livethingEncode({
          event: 'send-message',
          payload: { text: 'hello from bob' },
          metadata: { channel: { name: 'room2' } },
        }),
      );
    });

    // alice's captured frames should include the broadcast.
    const aliceGotMessage = await pageA.evaluate(async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const captured =
          (
            window as unknown as {
              __capture?: {
                event: string;
                payload: Record<string, unknown>;
                metadata?: Record<string, Record<string, unknown>> | null;
              }[];
            }
          ).__capture ?? [];
        const hit = captured.find(
          (m) =>
            m.event === 'room-message' &&
            m.metadata?.channel?.name === 'room2' &&
            m.payload?.text === 'hello from bob',
        );
        if (hit) return true;

        await new Promise((r) => setTimeout(r, 20));
      }

      return false;
    });

    expect(aliceGotMessage).toBe(true);

    await ctxA.close();
    await ctxB.close();
  });
});
