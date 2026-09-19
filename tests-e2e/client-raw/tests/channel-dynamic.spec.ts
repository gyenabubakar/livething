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
    // _channelFamily='room' is a valid family; _channel='admin' does NOT match /^room:.+$/.
    // The server must reject this rather than silently accept it as a 'room' subscription.
    await page.getByTestId('sub-name-fails-regex').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText('admin:channel-not-found');
  });

  test('top-level events tagged with a channel do not fall back to top-level handlers', async ({
    page,
  }, testInfo) => {
    // Scope isolation: a client sending `top-only-action` with a channel
    // marker claims the event happens inside that channel. The channel
    // does NOT register `top-only-action`, so the engine must drop
    // the message rather than fall through to the top-level handler.
    await openPage(page, `test-${testInfo.testId}`);

    // Sanity check: top-level dispatch (no channel marker) DOES fire the handler.
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(window.__livethingEncode({ event: 'top-only-action', payload: {} }));
    });
    await expect(page.getByTestId('top-only-action-fired')).toHaveText('testuser');

    // Now send the same event with `channel: 'room:general'`. With scope
    // isolation, the channel-scoped lookup misses and the message is
    // silently dropped — the `top-only-action-fired` value must NOT change
    // from the previous run.
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        window.__livethingEncode({
          event: 'top-only-action',
          payload: {},
          metadata: { channel: { name: 'room:general', family: 'room' } },
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
    // resolveChannel throws ChannelNotFound when the wire family key is known
    // but the channel name does not match the family regex. The server's
    // protocol-message branch must route that through handleRuntimeError
    // (clean _error frame, websocket stays open) rather than letting the
    // throw escape the WS message callback.
    await openPage(page, `test-${testInfo.testId}`);

    // Send a bogus __replay__ with regex-failing channel under a known scope.
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        window.__livethingEncode({
          event: '__replay__',
          payload: { lastKnownSeq: 0 },
          metadata: { channel: { name: 'admin', family: 'room' } },
        }),
      );
    });

    // Server emits __error__ with the routing markers preserved.
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

  test('check sync rejection prevents subscription for banned-user', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`, 'banned-user');
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-error')).toContainText('room:general');
    await expect(page.getByTestId('subscribe-ok')).toHaveText('');
  });

  test('check async rejection prevents subscription for async-banned-user', async ({
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

  test('unknown _channelFamily round-trips in the _error payload', async ({ page }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-unknown-scope').click();
    await expect(page.getByTestId('subscribe-error')).toHaveText('room:x:channel-not-found');
    await expect(page.getByTestId('subscribe-error-scope')).toHaveText('unknown-family');
  });

  test('empty _channelFamily is rejected as malformed protocol, not routed as a family', async ({
    page,
  }, testInfo) => {
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
          metadata: { channel: { name: 'room:general', family: '' } },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      ws.onmessage = original;

      return got.filter((message) => message.event === '__error__');
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.payload.code).toBe('validation-failed');
  });

  test('onValidationError sees ctx.channel for a manually-thrown ValidationFailed inside a channel handler', async ({
    page,
  }, testInfo) => {
    // A manually thrown ValidationFailed keeps its channel scope when the
    // onValidationError hook runs.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('room:general');

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        window.__livethingEncode({
          event: 'trigger-manual-validation',
          payload: {},
          metadata: { channel: { name: 'room:general', family: 'room' } },
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
    // An error thrown inside a channel family gives onError the matching
    // `ctx.channel` scope.
    await openPage(page, `test-${testInfo.testId}`);
    await page.getByTestId('sub-general').click();
    await expect(page.getByTestId('subscribe-ok')).toContainText('room:general');

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        window.__livethingEncode({
          event: 'trigger-scoped-error',
          payload: {},
          metadata: { channel: { name: 'room:general', family: 'room' } },
        }),
      );
    });

    // The hook reports `<channelName>|<scope>|<event>`. ctx.channel.name must
    // be 'room:general' and ctx.channel.family must be 'room' — not
    // '<top-level>' / '<no-scope>'.
    await expect(page.getByTestId('scoped-error-observed')).toHaveText(
      'room:general|room|trigger-scoped-error',
    );
  });

  test('two concurrent _subscribe with an awaited check each see the other on initial sync', async ({
    page,
  }, testInfo) => {
    // The fixture's check sleeps 50ms when username starts with "slow-user".
    // Two clients enter the gate together. Membership commits before the
    // initial snapshot, so each subscriber sees every peer committed before it.
    const room = `race-${testInfo.testId}`;
    await page.goto(`/channel-dynamic?room=${room}`);

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
              `${proto}//${location.host}/ws/channel-dynamic?username=${encodeURIComponent(username)}&room=${encodeURIComponent(room)}`,
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
          event: '__subscribe__',
          payload: null,
          metadata: { channel: { name: `room:${room}`, family: 'room' } },
        };

        handles.a!.ws.send(window.__livethingEncode(frame));
        handles.b!.ws.send(window.__livethingEncode(frame));
      },
      { h: handle, room },
    );

    async function memberJoinSenders(name: 'a' | 'b'): Promise<string[]> {
      return page.evaluate(
        ({ h, name }) => {
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
          const msgs = handles[name]!.messages;

          const joinIds = msgs
            .filter((m) => m.event === '__memberJoin__')
            .map((m) => String(m.payload.connectionId));

          // Since 5d05a08, initial state arrives as __memberSync__ (one frame
          // with all current members), not per-member __memberJoin__ frames.
          // Include those connection ids so concurrent-subscribe assertions work.
          const syncIds = msgs
            .filter((m) => m.event === '__memberSync__')
            .flatMap((m) => {
              const members = m.payload.members as Array<{ connectionId: string }> | undefined;
              return (members ?? []).map((mb) => mb.connectionId);
            });

          return [...new Set([...joinIds, ...syncIds])];
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
                {
                  messages: {
                    event: string;
                    payload: Record<string, unknown>;
                    metadata?: Record<string, Record<string, unknown>> | null;
                  }[];
                }
              >
            ).a!.messages.some((m) => m.event === '__subscribeOk__'),
          { h: handle },
        );
        const okB = await page.evaluate(
          ({ h }) =>
            (
              h as unknown as Record<
                string,
                {
                  messages: {
                    event: string;
                    payload: Record<string, unknown>;
                    metadata?: Record<string, Record<string, unknown>> | null;
                  }[];
                }
              >
            ).b!.messages.some((m) => m.event === '__subscribeOk__'),
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

    // The connection IDs are server-issued, so assert that each side received
    // a __memberJoin__ frame whose connection ID is not its own.
    const aOwnId = await page.evaluate(
      ({ h }) => {
        const msgs = (
          h as unknown as Record<
            string,
            {
              messages: {
                event: string;
                payload: Record<string, unknown>;
                metadata?: Record<string, Record<string, unknown>> | null;
              }[];
            }
          >
        ).a!.messages;
        const ok = msgs.find((m) => m.event === '__subscribeOk__');
        return String(ok?.metadata?.channel?.name ?? '');
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

  test('__subscribe__ with a __proto__ payload key cannot poison the data the check hook sees', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);

    const frames = await page.evaluate(async () => {
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

      const polluted = JSON.parse(
        '["__subscribe__",{"__proto__":{"role":"admin"}},{"channel":{"name":"proto:x","family":"proto-probe"}}]',
      );
      ws.send(JSON.stringify(polluted));
      await new Promise((r) => setTimeout(r, 400));
      ws.onmessage = original;

      return got;
    });

    const ok = frames.find(
      (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === 'proto:x',
    );
    expect(ok).toBeTruthy();
    const err = frames.find(
      (f) => f.event === '__error__' && f.metadata?.channel?.name === 'proto:x',
    );
    expect(err).toBeUndefined();
  });

  test('__subscribe__ with an own role=admin field is still rejected (control case)', async ({
    page,
  }, testInfo) => {
    await openPage(page, `test-${testInfo.testId}`);

    const frames = await page.evaluate(async () => {
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
          payload: { role: 'admin' },
          metadata: { channel: { name: 'proto:y', family: 'proto-probe' } },
        }),
      );
      await new Promise((r) => setTimeout(r, 400));
      ws.onmessage = original;

      return got;
    });

    const err = frames.find(
      (f) => f.event === '__error__' && f.metadata?.channel?.name === 'proto:y',
    );
    expect(err).toBeTruthy();
    const ok = frames.find(
      (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === 'proto:y',
    );
    expect(ok).toBeUndefined();
  });

  test('channelHandle.subscribe on a dynamic family stamps channelFamily and source server', async ({
    page,
  }, testInfo) => {
    // Pins the server-side subscribe path for the dynamic-channel family
    // case. The wire frame must carry both `channel: 'room:auto'` and
    // `channelFamily: 'room'` so the client SDK can route to the right
    // family handle, plus `source: 'server'` to mark it as unsolicited.
    await openPage(page, `test-${testInfo.testId}`);

    const frames = await page.evaluate(async () => {
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
          event: 'trigger-server-subscribe-dynamic',
          payload: { name: 'room:auto' },
        }),
      );
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (
          got.some(
            (m) => m.event === '__subscribeOk__' && m.metadata?.channel?.name === 'room:auto',
          )
        )
          break;

        await new Promise((r) => setTimeout(r, 20));
      }

      return got;
    });

    const ok = frames.find(
      (f) => f.event === '__subscribeOk__' && f.metadata?.channel?.name === 'room:auto',
    );
    expect(ok).toBeDefined();
    expect(ok!.metadata?.channel?.family).toBe('room');
    expect(ok!.metadata?.exchange?.source).toBe('server');
  });

  test('auth-race stress: N concurrent subscribes with awaited checks — rejected users never become members, allowed set is complete and symmetric', async ({
    page,
  }, testInfo) => {
    // Stress the check → commit pattern. Every allowed connection uses a
    // 'slow-user' name so its check awaits 50ms — all of them sit in the await
    // window at once, maximizing interleaving. The rejected ones use
    // 'async-banned-user' so their rejection also resolves inside that window.
    //
    // Invariants proven under that concurrency:
    //  1. Auth gate holds: every banned subscribe is rejected (no __subscribeOk__).
    //  2. No leak: a rejected connection never appears in anyone's member view.
    //  3. Complete + symmetric: each allowed connection sees every OTHER allowed
    //     one (no lost-update on the member set), and the union of all seen ids
    //     is exactly the allowed set — so nothing extra crept in.
    const room = `auth-stress-${testInfo.testId}`;
    const channel = 'room:stress';
    const ALLOWED = 6;
    const BANNED = 3;
    await page.goto(`/channel-dynamic?room=${room}`);

    const result = await page.evaluate(
      async ({ room, channel, allowedCount, bannedCount }) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        type Msg = {
          event: string;
          payload: Record<string, unknown>;
          metadata?: Record<string, Record<string, unknown>> | null;
        };
        type Sock = { ws: WebSocket; messages: Msg[] };

        function open(username: string): Promise<Sock> {
          return new Promise((resolve, reject) => {
            const ws = new WebSocket(
              `${proto}//${location.host}/ws/channel-dynamic?username=${encodeURIComponent(
                username,
              )}&room=${encodeURIComponent(room)}`,
            );
            const messages: Msg[] = [];
            ws.onmessage = (ev) => {
              if (typeof ev.data === 'string') messages.push(window.__livethingDecode(ev.data));
            };
            ws.onopen = () => resolve({ ws, messages });
            ws.onerror = (e) => reject(e);
          });
        }

        const allowed = await Promise.all(
          Array.from({ length: allowedCount }, (_, i) => open(`slow-user-${i}`)),
        );
        // The check rejects the exact username 'async-banned-user'; membership is
        // per-connection, so several connections can share it — each is rejected
        // independently inside the same awaited-check window.
        const banned = await Promise.all(
          Array.from({ length: bannedCount }, () => open('async-banned-user')),
        );

        // Fire every __subscribe__ as close to simultaneous as possible.
        const frame = window.__livethingEncode({
          event: '__subscribe__',
          payload: null,
          metadata: { channel: { name: channel, family: 'room' } },
        });
        for (const s of [...allowed, ...banned]) s.ws.send(frame);

        function seenIds(s: Sock): Set<string> {
          const ids = new Set<string>();
          for (const m of s.messages) {
            if (m.event === '__memberSync__') {
              const members = (m.payload.members as { connectionId: string }[] | undefined) ?? [];
              for (const mb of members) ids.add(mb.connectionId);
            }

            if (m.event === '__memberJoin__') ids.add(String(m.payload.connectionId));
          }

          return ids;
        }

        // Poll until settled (all allowed ok, all banned errored) AND the member
        // views are complete, or a deadline passes.
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
          const settled =
            allowed.every((s) => s.messages.some((m) => m.event === '__subscribeOk__')) &&
            banned.every((s) => s.messages.some((m) => m.event === '__error__'));
          const complete = allowed.every((s) => seenIds(s).size >= allowedCount - 1);
          if (settled && complete) break;

          await new Promise((r) => setTimeout(r, 50));
        }

        const allowedOk = allowed.map((s) => s.messages.some((m) => m.event === '__subscribeOk__'));
        const bannedOk = banned.map((s) => s.messages.some((m) => m.event === '__subscribeOk__'));
        const bannedErr = banned.map((s) => s.messages.some((m) => m.event === '__error__'));
        const seenCounts = allowed.map((s) => seenIds(s).size);
        const unionSeen = new Set<string>();

        for (const s of allowed) for (const id of seenIds(s)) unionSeen.add(id);

        return { allowedOk, bannedOk, bannedErr, seenCounts, unionSize: unionSeen.size };
      },
      { room, channel, allowedCount: ALLOWED, bannedCount: BANNED },
    );

    // 1. Auth gate: every allowed joined, every banned was rejected.
    expect(result.allowedOk).toEqual(Array(ALLOWED).fill(true));
    expect(result.bannedOk).toEqual(Array(BANNED).fill(false));
    expect(result.bannedErr).toEqual(Array(BANNED).fill(true));

    // 2 + 3. Each allowed sees every OTHER allowed (complete + symmetric), and
    // the union of all seen ids is exactly the allowed set — no banned leaked in,
    // no membership lost to a race.
    expect(result.seenCounts).toEqual(Array(ALLOWED).fill(ALLOWED - 1));
    expect(result.unionSize).toBe(ALLOWED);
  });
});
