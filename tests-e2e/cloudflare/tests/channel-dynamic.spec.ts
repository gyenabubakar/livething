import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe('channel-dynamic', () => {
  async function openPage(page: Page, room: string, username = 'testuser') {
    await page.goto(`/channel-dynamic?room=${room}`);
    await page.getByTestId('username').fill(username);
    await page.getByTestId('connect').click();
    await expect(page.getByTestId('status')).toHaveText('connected');
  }

  test('subscribing to a name that matches the regex joins the connection', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('room:general');
  });

  test('subscribing without a recognised scope emits _error channel-not-found', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-zzz-no-scope').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText('zzz:channel-not-found');
  });

  test('subscribing with a name that fails the family regex emits _error channel-not-found', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    // _channelScope='room' is a valid family; _channel='admin' does NOT match /^room:.+$/.
    // The server must reject this rather than silently accept it as a 'room' subscription.
    await page.getByTestId('sub-name-fails-regex').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText('admin:channel-not-found');
  });

  test('top-level events tagged with _channel do not fall back to top-level handlers', async ({
    page,
  }, testInfo) => {
    // Scope isolation: a client sending `top-only-action` with `_channel`
    // claims the event happens inside that channel scope. The channel
    // scope does NOT register `top-only-action`, so the engine must drop
    // the message rather than fall through to the top-level handler.
    await openPage(page, `test-${testInfo.testId}`);

    // Sanity check: top-level dispatch (no `_channel`) DOES fire the handler.
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(JSON.stringify({ event: 'top-only-action', payload: {} }));
    });
    await expect(page.getByTestId('top-only-action-fired')).toHaveText('testuser');

    // Now send the same event with `_channel: 'room:general'`. With scope
    // isolation, the channel-scoped lookup misses and the message is
    // silently dropped — the `top-only-action-fired` value must NOT change
    // from the previous run.
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'top-only-action',
          payload: { _channel: 'room:general', _channelScope: 'room' },
        }),
      );
    });

    // Positive signal that round-trips have been processed: a normal scoped
    // send still works and the room receives it.
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('room:general');
    await page.getByTestId('echo-name-general').click();
    await expect(page.getByTestId('name-result')).toHaveText('room:general|general');

    // The top-level handler did not fire a second time during the
    // channel-scoped send — the value is still the one from the sanity check.
    expect(await page.getByTestId('top-only-action-fired').textContent()).toBe('testuser');
  });

  test('protocol-event with regex-failing scope keeps the websocket alive', async ({
    page,
  }, testInfo) => {
    // resolveScope throws ChannelNotFound when the wire scope key is known
    // but the channel name does not match the family regex. The server's
    // protocol-message branch must route that through handleRuntimeError
    // (clean _error frame, websocket stays open) rather than letting the
    // throw escape the WS message callback.
    await openPage(page, `test-${testInfo.testId}`);

    // Send a bogus _replay with regex-failing channel under a known scope.
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: '_replay',
          payload: { _channel: 'admin', _channelScope: 'room', since: 0 },
        }),
      );
    });

    // Server emits _error with the routing markers preserved.
    await expect(page.getByTestId('subscribe-error')).toHaveText('admin:channel-not-found');
    await expect(page.getByTestId('subscribe-error-scope')).toHaveText('room');

    // The websocket must still be alive — a follow-up valid subscribe still works.
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('room:general');
    await expect(page.getByTestId('status')).toHaveText('connected');
  });

  test('dynamic channels with different suffixes stay isolated', async ({ browser }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    // Bob subscribes to BOTH channels so he's the positive-signal receiver
    // for either side. Alice is only on general.
    await a.getByTestId('sub-general').click();
    await b.getByTestId('sub-general').click();
    await b.getByTestId('sub-vip').click();
    await expect(a.getByTestId('subscribe-ok')).toContainText('room:general');
    await expect(b.getByTestId('subscribe-ok')).toContainText('room:general');
    await expect(b.getByTestId('subscribe-ok')).toContainText('room:vip');

    // Alice publishes to general. Bob (on both) MUST see it on general —
    // that receipt is the positive signal. Bob's vip bucket MUST stay
    // empty, proving dynamic-scope isolation.
    await a.getByTestId('send-general').click();
    await expect(b.getByTestId('user-msgs-general')).toContainText('alice:hello-general');
    await expect(b.getByTestId('user-msgs-vip')).toHaveText('');

    await ctxA.close();
    await ctxB.close();
  });

  test('ctx.channel.broadcast reaches peers subscribed to the same dynamic channel name', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');
    await a.getByTestId('sub-general').click();
    await b.getByTestId('sub-general').click();
    await expect(a.getByTestId('subscribe-ok')).toContainText('room:general');
    await expect(b.getByTestId('subscribe-ok')).toContainText('room:general');

    await a.getByTestId('send-general').click();
    await expect(b.getByTestId('user-msgs-general')).toContainText('alice:hello-general');

    await ctxA.close();
    await ctxB.close();
  });

  test('onSubscribe broadcasts a system message to existing dynamic members', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await a.getByTestId('sub-general').click();
    await expect(a.getByTestId('subscribe-ok')).toContainText('room:general');

    await openPage(b, room, 'bob');
    await b.getByTestId('sub-general').click();
    await expect(a.getByTestId('system-msgs-general')).toContainText('bob entered');

    await ctxA.close();
    await ctxB.close();
  });

  test('onUnsubscribe broadcasts a system message when client leaves the dynamic channel', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await a.getByTestId('sub-general').click();
    await expect(a.getByTestId('subscribe-ok')).toContainText('room:general');

    await openPage(b, room, 'bob');
    await b.getByTestId('sub-general').click();
    await expect(a.getByTestId('system-msgs-general')).toContainText('bob entered');

    await b.close();
    await expect(a.getByTestId('system-msgs-general')).toContainText('bob left');

    await ctxA.close();
    await ctxB.close();
  });

  test('onBeforeSubscribe sync rejection prevents subscription for banned-user', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`, 'banned-user');
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-error')).toContainText('room:general');
    await expect(page.getByTestId('subscribe-ok')).toHaveText('');
  });

  test('onBeforeSubscribe async rejection prevents subscription for async-banned-user', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`, 'async-banned-user');
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-error')).toContainText('room:general');
    await expect(page.getByTestId('subscribe-ok')).toHaveText('');
  });

  test('regex scope exposes the full matched name and its suffix inside the handler', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-alpha-123').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('room:alpha-123');
    await page.getByTestId('echo-name-alpha-123').click();
    await expect(page.getByTestId('name-result')).toHaveText('room:alpha-123|alpha-123');
  });

  test('unknown _channelScope round-trips in the _error payload', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-unknown-scope').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText('room:x:channel-not-found');
    await expect(page.getByTestId('subscribe-error-scope')).toHaveText('unknown-family');
  });

  test('onValidationError sees ctx.channel for a manually-thrown ValidationFailed inside a channel handler', async ({
    page,
  }, testInfo) => {
    // Pre-fix the outer dispatch catch called handleValidationError
    // without scope, so onValidationError saw a top-level ctx (no
    // ctx.channel) for manually-thrown ValidationFailed. The hook
    // couldn't tell which channel the failure happened in.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('room:general');

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'trigger-manual-validation',
          payload: { _channel: 'room:general', _channelScope: 'room' },
        }),
      );
    });

    // The hook reports `<channelName>|<event>`. ctx.channel.name must be
    // 'room:general', not '<top-level>'.
    await expect(page.getByTestId('validation-observed')).toHaveText(
      'room:general|trigger-manual-validation',
    );
  });

  test('onError sees ctx.channel for an unrecognized error thrown inside a channel handler', async ({
    page,
  }, testInfo) => {
    // Pre-fix sendRuntimeError built the onError hook ctx without scope, so
    // ctx.channel was undefined even when the throw came from inside a
    // channel family. The hook had no way to log "which room blew up."
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('room:general');

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'trigger-scoped-error',
          payload: { _channel: 'room:general', _channelScope: 'room' },
        }),
      );
    });

    // The hook reports `<channelName>|<scope>|<event>`. ctx.channel.name must
    // be 'room:general' and ctx.channel.scope must be 'room' — not
    // '<top-level>' / '<no-scope>'.
    await expect(page.getByTestId('scoped-error-observed')).toHaveText(
      'room:general|room|trigger-scoped-error',
    );
  });

  test('regular events tagged with an unknown _namespace do not fall back to top-level handlers', async ({
    page,
  }, testInfo) => {
    // A client tagging `top-only-action` with `_namespace: 'typo'` claims
    // the event happens inside a namespace scope. The namespace doesn't
    // exist — the engine must reject the message rather than fall through
    // to the top-level handler.
    await openPage(page, `test-${testInfo.testId}`);

    // Sanity: the top-level handler fires when no scope marker is present.
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(JSON.stringify({ event: 'top-only-action', payload: {} }));
    });
    await expect(page.getByTestId('top-only-action-fired')).toHaveText('testuser');

    // Now claim an unknown namespace. Pre-fix this fell back to the
    // top-level handler. Post-fix the engine emits a `_error` with code
    // `namespace-not-found` and the top-level handler does not fire again.
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'top-only-action',
          payload: { _namespace: 'typo' },
        }),
      );
    });

    // Wait for any rogue dispatch to have arrived.
    await page.waitForTimeout(1000);
    // The top-level handler did NOT fire a second time — value still from
    // the sanity check (the page overwrites on each fire).
    expect(await page.getByTestId('top-only-action-fired').textContent()).toBe('testuser');
  });

  test('two concurrent _subscribe with an awaited onBeforeSubscribe each see the other on initial sync', async ({
    page,
  }, testInfo) => {
    // The fixture's onBeforeSubscribe sleeps 50ms when username starts
    // with "slow-user". Two clients hit that gate at the same time so
    // both sit in the await before either commits membership. Pre-fix
    // each snapshotted the empty member list before the await, then
    // both committed, and each connection saw an empty initial sync —
    // A's view excluded B and B's view excluded A. Post-fix membership
    // commits before the snapshot, so each new subscriber sees every
    // peer that committed before it (filtered against itself).
    const room = `race-${testInfo.testId}`;
    await page.goto(`/channel-dynamic?room=${room}`);

    const handle = await page.evaluateHandle(
      async ({ room }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        function open(username: string): Promise<{
          ws: WebSocket;
          messages: { event: string; payload: Record<string, unknown> }[];
        }> {
          return new Promise((resolve, reject) => {
            const ws = new WebSocket(
              `${proto}//${location.host}/ws/channel-dynamic?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
            );
            const messages: { event: string; payload: Record<string, unknown> }[] = [];
            ws.onmessage = (ev) => {
              if (typeof ev.data !== 'string') return;
              messages.push(JSON.parse(ev.data));
            };
            ws.onopen = () => resolve({ ws, messages });
            ws.onerror = (e) => reject(e);
          });
        }
        const a = await open('slow-user-a');
        const b = await open('slow-user-b');
        return { a, b };
      },
      { room },
    );

    // Fire both _subscribe frames as close to simultaneous as possible
    // (single page.evaluate, both ws.send calls back-to-back).
    await page.evaluate(
      ({ h, room }) => {
        const handles = h as unknown as Record<string, { ws: WebSocket }>;
        const frame = {
          event: '_subscribe',
          payload: { _channel: `room:${room}`, _channelScope: 'room' },
        };
        handles.a!.ws.send(JSON.stringify(frame));
        handles.b!.ws.send(JSON.stringify(frame));
      },
      { h: handle, room },
    );

    async function memberJoinSenders(name: 'a' | 'b'): Promise<string[]> {
      return page.evaluate(
        ({ h, name }) => {
          const handles = h as unknown as Record<
            string,
            { messages: { event: string; payload: Record<string, unknown> }[] }
          >;
          return handles[name]!.messages.filter((m) => m.event === '_memberJoin').map((m) =>
            String(m.payload.connectionId),
          );
        },
        { h: handle, name },
      );
    }

    // Wait until both have completed _subscribeOk so the race window is
    // closed before assertions.
    await expect
      .poll(async () => {
        const okA = await page.evaluate(
          ({ h }) =>
            (
              h as unknown as Record<
                string,
                { messages: { event: string; payload: Record<string, unknown> }[] }
              >
            ).a!.messages.some((m) => m.event === '_subscribeOk'),
          { h: handle },
        );
        const okB = await page.evaluate(
          ({ h }) =>
            (
              h as unknown as Record<
                string,
                { messages: { event: string; payload: Record<string, unknown> }[] }
              >
            ).b!.messages.some((m) => m.event === '_subscribeOk'),
          { h: handle },
        );
        return okA && okB;
      })
      .toBe(true);

    // Allow a microtask for the post-commit broadcasts to land.
    await expect
      .poll(async () => {
        const seenByA = new Set(await memberJoinSenders('a'));
        const seenByB = new Set(await memberJoinSenders('b'));
        // Each side must learn about the other exactly once via either
        // path (initial sync OR broadcast). Same-id duplicates are
        // tolerated by the client so we assert presence, not count.
        return seenByA.size + seenByB.size;
      })
      .toBeGreaterThanOrEqual(2);

    const seenByA = await memberJoinSenders('a');
    const seenByB = await memberJoinSenders('b');

    // The connection ids are server-issued so we can't check exact ids;
    // assert that each side received a _memberJoin frame whose
    // connectionId is NOT its own. Pre-fix one of these arrays was
    // empty.
    const aOwnId = await page.evaluate(
      ({ h }) => {
        const msgs = (
          h as unknown as Record<
            string,
            { messages: { event: string; payload: Record<string, unknown> }[] }
          >
        ).a!.messages;
        const ok = msgs.find((m) => m.event === '_subscribeOk');
        return String(ok?.payload?._channel ?? '');
      },
      { h: handle },
    );
    expect(aOwnId).toContain('room:race-');

    expect(seenByA.length).toBeGreaterThan(0);
    expect(seenByB.length).toBeGreaterThan(0);
  });

  test('two clients on the same dynamic channel name are in the same broadcast group', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await openPage(a, room, 'alice');
    await openPage(b, room, 'bob');

    // Both subscribe to the SAME dynamic channel (room:general)
    await a.getByTestId('sub-general').click();
    await b.getByTestId('sub-general').click();
    await expect(a.getByTestId('subscribe-ok')).toContainText('room:general');
    await expect(b.getByTestId('subscribe-ok')).toContainText('room:general');

    // ctx.channel.broadcast is peer-only; round-trip to verify the shared group.
    await a.getByTestId('send-general').click();
    await expect(b.getByTestId('user-msgs-general')).toContainText('alice:hello-general');

    await b.getByTestId('send-general').click();
    await expect(a.getByTestId('user-msgs-general')).toContainText('bob:hello-general');

    await ctxA.close();
    await ctxB.close();
  });
});
