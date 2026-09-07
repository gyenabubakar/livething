import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout: 10_000 });
}

test.describe('replay handler', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    const room = `test-${testInfo.testId}`;
    await page.goto(`/replay?room=${room}`);
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
  });

  test('sends and receives messages', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /testuser: hello from replay/);
  });

  test('private request responses are not stored or resent on __replay__', async ({ page }) => {
    // Pre-fix the replay store persisted any outgoing frame including
    // ctx.respond(...) responses (which carry a correlationId). A different
    // client could later send __replay__ { lastKnownSeq: 0 } and receive
    // somebody else's request response.
    //
    // Send a request, receive the response, then ask for replay since 0
    // and assert nothing comes back with a correlationId field.
    const result = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      const got: {
        event: string;
        payload: Record<string, unknown>;
        __wskit?: Record<string, unknown>;
      }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') got.push(JSON.parse(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };
      // Send a request with a correlationId. The handler responds with a token.
      ws.send(
        JSON.stringify({
          event: 'get-token',
          payload: {},
          __wskit: { correlationId: 'req-test-1' },
        }),
      );
      await new Promise((r) => setTimeout(r, 200));
      // Ask for full replay history.
      ws.send(JSON.stringify({ event: '__replay__', payload: { lastKnownSeq: 0 }, __wskit: {} }));
      await new Promise((r) => setTimeout(r, 400));
      ws.onmessage = original;

      return got;
    });

    // The response itself was delivered to the original requester.
    const directResponse = result.find(
      (m) => m.event === 'get-token' && m.__wskit?.correlationId === 'req-test-1',
    );
    expect(directResponse).toBeDefined();
    expect(directResponse!.payload.token).toBe('secret-for-testuser');

    // No replayed frame should carry a correlationId.
    const replayedWithCorrelationId = result.filter(
      (m) =>
        m.event === 'get-token' &&
        typeof m.__wskit?.correlationId === 'string' &&
        m.__wskit.correlationId !== 'req-test-1',
    );
    expect(replayedWithCorrelationId).toEqual([]);

    // Stronger check: the response must not be replayed at all. The original
    // arrived once (above); if replay had stored it, we would see it twice.
    const allGetTokenFrames = result.filter((m) => m.event === 'get-token');
    expect(allGetTokenFrames).toHaveLength(1);
  });

  test('malformed lastKnownSeq on __replay__ surfaces __error__ with code "validation-failed"', async ({
    page,
  }) => {
    // Pre-fix the protocol handler ran `Number(payload?.since ?? 0)` which
    // happily turned a non-numeric cursor into NaN and bound that into the
    // SQL query. NaN compares false against every row, so the client got
    // zero rows back and no signal that its frame was malformed. The
    // protocol handler now rejects anything that is not a non-negative
    // integer with a typed validation error, surfaced on the wire as
    // `__error__ { code: 'validation-failed' }`.
    const errors = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      const got: { event: string; payload: Record<string, unknown> }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') got.push(JSON.parse(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };

      ws.send(
        JSON.stringify({ event: '__replay__', payload: { lastKnownSeq: 'abc' }, __wskit: {} }),
      );
      await new Promise((r) => setTimeout(r, 300));
      ws.onmessage = original;

      return got.filter((m) => m.event === '__error__');
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.payload.code).toBe('validation-failed');
  });

  test('stream chunks are not persisted into replay and never resend on __replay__', async ({
    page,
  }) => {
    // Stream chunks carry `streamId` so they reach an active stream on
    // the original connection. Replay must not store them: a reconnecting
    // client has no stream by that id, and Issue #3 tracks proper stream
    // replay across reconnect. Pre-fix the persist filter only blocked
    // `correlationId`, so chunks slipped into `__wskit_replay` and came
    // back on every later `__replay__ lastKnownSeq: 0`.
    const result = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      const got: {
        event: string;
        payload: Record<string, unknown>;
        __wskit?: Record<string, unknown>;
      }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') got.push(JSON.parse(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };

      ws.send(JSON.stringify({ event: 'start-tiny-stream', payload: {} }));
      await new Promise((r) => setTimeout(r, 300));
      ws.send(JSON.stringify({ event: '__replay__', payload: { lastKnownSeq: 0 }, __wskit: {} }));
      await new Promise((r) => setTimeout(r, 400));
      ws.onmessage = original;

      return got;
    });

    // The live chunk reached the original connection (sanity check). The
    // chunk wire event carries the originating event name and a `streamId`.
    const liveChunks = result.filter(
      (m) => m.event === 'start-tiny-stream' && typeof m.__wskit?.streamId === 'string',
    );
    expect(liveChunks).toHaveLength(1);
    expect(liveChunks[0]!.payload.value).toBe('one');
  });

  test('sequence numbers present', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    const seq = await page.getByTestId('last-seq').textContent();
    expect(Number(seq)).toBeGreaterThan(0);
  });

  test('replay returns stored messages after sending', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);

    const beforeCount = (await page.getByTestId('messages').textContent())!.split(' | ').length;
    await page.getByTestId('replay-btn').click();
    await expect(async () => {
      const afterCount = (await page.getByTestId('messages').textContent())!.split(' | ').length;
      expect(afterCount).toBeGreaterThan(beforeCount);
    }).toPass({ timeout: 5_000 });
  });

  test('excluded events not replayed (cursor excluded)', async ({ page }) => {
    await page.getByTestId('send-cursor-btn').click();
    await waitForText(page, 'cursor-events', /100,200/);

    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);

    const cursorCountBefore = (await page.getByTestId('cursor-events').textContent())!.split(
      ' | ',
    ).length;
    await page.getByTestId('replay-btn').click();

    await expect(async () => {
      const messagesAfter = await page.getByTestId('messages').textContent();
      expect(messagesAfter).toContain('hello from replay');
      const replayCount = Number(await page.getByTestId('replay-count').textContent());
      expect(replayCount).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });

    const cursorCountAfter = (await page.getByTestId('cursor-events').textContent())!.split(
      ' | ',
    ).length;
    expect(cursorCountAfter).toBe(cursorCountBefore);
  });

  test('channel-scoped replay returns only channel messages', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');

    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);

    await page.getByTestId('room-send-btn').click();
    await waitForText(page, 'room-messages', /room hello/);

    const messagesBefore = await page.getByTestId('messages').textContent();

    await page.getByTestId('room-replay-btn').click();
    await expect(async () => {
      const roomReplayCount = Number(await page.getByTestId('room-replay-count').textContent());
      expect(roomReplayCount).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });

    // Channel replay must not leak top-level messages back to the client.
    const messagesAfter = await page.getByTestId('messages').textContent();
    expect(messagesAfter).toBe(messagesBefore);
  });

  test('channel replay supports nonzero since', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'send-room-msg',
          payload: { text: 'room-old-1' },
          __wskit: { channel: 'replay-room' },
        }),
      );
      ws?.send(
        JSON.stringify({
          event: 'send-room-msg',
          payload: { text: 'room-old-2' },
          __wskit: { channel: 'replay-room' },
        }),
      );
    });
    await waitForText(page, 'room-messages', /room-old-2/);

    const seqBefore = Number(await page.getByTestId('last-seq').textContent());

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'send-room-msg',
          payload: { text: 'room-new-1' },
          __wskit: { channel: 'replay-room' },
        }),
      );
      ws?.send(
        JSON.stringify({
          event: 'send-room-msg',
          payload: { text: 'room-new-2' },
          __wskit: { channel: 'replay-room' },
        }),
      );
    });
    await waitForText(page, 'room-messages', /room-new-2/);

    await page.reload();
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('room-join-btn').click();

    await waitForText(page, 'room-subscribed', 'subscribed');

    await page.evaluate((since) => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: '__replay__',
          payload: { lastKnownSeq: since },
          __wskit: { channel: 'replay-room' },
        }),
      );
    }, seqBefore);

    await expect(async () => {
      const roomMessages = await page.getByTestId('room-messages').textContent();
      expect(roomMessages).toContain('room-new-1');
      expect(roomMessages).toContain('room-new-2');
      expect(roomMessages).not.toContain('room-old-1');
      expect(roomMessages).not.toContain('room-old-2');
    }).toPass({ timeout: 5_000 });
  });

  test('programmatic sendReplay delivers message', async ({ page }) => {
    await page.getByTestId('request-history-btn').click();
    await waitForText(page, 'history-injected', 'true');
  });

  test('channel sendReplay delivers message in channel scope', async ({ page }) => {
    await page.getByTestId('room-join-btn').click();
    await waitForText(page, 'room-subscribed', 'subscribed');
    await page.getByTestId('request-room-history-btn').click();
    await waitForText(page, 'room-history-injected', 'true');
  });

  test('top-level ctx.sendReplay forwards channelFamily onto the wire (built-in replay)', async ({
    page,
  }) => {
    // Pre-fix the built-in replay primitive's top-level sendReplay
    // hardcoded channelFamily=null. A handler that injects a family-scoped
    // history frame (channel='fam-1', channelFamily='fams') was producing
    // a wire frame with channel='fam-1' but no channelFamily='fams', so
    // client-side family routing could not place it.
    const frame = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      const got: {
        event: string;
        payload: Record<string, unknown>;
        __wskit?: Record<string, unknown>;
      }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') got.push(JSON.parse(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };

      ws.send(JSON.stringify({ event: 'inject-family-replay', payload: {} }));
      await new Promise((r) => setTimeout(r, 300));
      ws.onmessage = original;

      return got.find((m) => m.event === 'room-msg' && m.payload.text === 'family-injected');
    });

    expect(frame).toBeDefined();
    expect(frame!.__wskit?.channel).toBe('fam-1');
    expect(frame!.__wskit?.channelFamily).toBe('fams');
  });

  test('channel replay:false opts out of the cascade: optout-room stores nothing, replay-room does', async ({
    page,
  }) => {
    // The contract enables built-in replay at the top level, which normally
    // cascades into every channel that did not configure its own replay.
    // `optout-room` declares `replay: false`, which claims the channel scope
    // with a DISABLED replay primitive: the top-level store skips it (it is in
    // the claimed-scope set) and no channel-level store/handler is installed
    // for it. So __replay__ for optout-room returns nothing while the control
    // `replay-room` (replay: true) returns its stored rows. Both clients are
    // live members of both channels, so the membership gate passes for both
    // requests — the only thing suppressing optout-room rows is the opt-out.
    const result = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');

      function waitFor(predicate: (m: Record<string, unknown>) => boolean, timeoutMs: number) {
        return new Promise<void>((resolve, reject) => {
          const prior = ws!.onmessage;
          const timer = setTimeout(() => {
            ws!.onmessage = prior;
            reject(new Error('timeout waiting for frame'));
          }, timeoutMs);
          ws!.onmessage = (ev) => {
            if (typeof prior === 'function') prior.call(ws!, ev);
            if (typeof ev.data === 'string') {
              const m = JSON.parse(ev.data) as Record<string, unknown>;
              if (predicate(m)) {
                clearTimeout(timer);
                ws!.onmessage = prior;
                resolve();
              }
            }
          };
        });
      }

      function subscribedOk(channel: string) {
        return (m: Record<string, unknown>) =>
          m.event === '__subscribeOk__' &&
          (m.__wskit as Record<string, unknown> | undefined)?.channel === channel;
      }

      // Subscribe to both channels and confirm membership before publishing.
      ws.send(
        JSON.stringify({
          event: '__subscribe__',
          payload: {},
          __wskit: { channel: 'optout-room' },
        }),
      );
      await waitFor(subscribedOk('optout-room'), 4000);
      ws.send(
        JSON.stringify({
          event: '__subscribe__',
          payload: {},
          __wskit: { channel: 'replay-room' },
        }),
      );
      await waitFor(subscribedOk('replay-room'), 4000);

      // Publish one message to each channel. ctx.channel.send delivers the
      // frame back to this publisher, so we can confirm both lands live.
      ws.send(
        JSON.stringify({
          event: 'send-room-msg',
          payload: { text: 'optout-live' },
          __wskit: { channel: 'optout-room' },
        }),
      );
      await waitFor(
        (m) =>
          m.event === 'room-msg' &&
          (m.payload as { text?: string }).text === 'optout-live' &&
          (m.__wskit as Record<string, unknown> | undefined)?.channel === 'optout-room',
        4000,
      );
      ws.send(
        JSON.stringify({
          event: 'send-room-msg',
          payload: { text: 'control-live' },
          __wskit: { channel: 'replay-room' },
        }),
      );
      await waitFor(
        (m) =>
          m.event === 'room-msg' &&
          (m.payload as { text?: string }).text === 'control-live' &&
          (m.__wskit as Record<string, unknown> | undefined)?.channel === 'replay-room',
        4000,
      );

      // Now capture only the frames that arrive during the replay window.
      const replayed: {
        event: string;
        payload: Record<string, unknown>;
        __wskit?: Record<string, unknown>;
      }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') replayed.push(JSON.parse(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };

      ws.send(
        JSON.stringify({
          event: '__replay__',
          payload: { lastKnownSeq: 0 },
          __wskit: { channel: 'optout-room' },
        }),
      );
      await new Promise((r) => setTimeout(r, 500));

      ws.send(
        JSON.stringify({
          event: '__replay__',
          payload: { lastKnownSeq: 0 },
          __wskit: { channel: 'replay-room' },
        }),
      );
      await new Promise((r) => setTimeout(r, 500));

      ws.onmessage = original;

      return replayed.filter((m) => m.event === 'room-msg');
    });

    const optoutReplayed = result.filter((m) => m.__wskit?.channel === 'optout-room');
    const controlReplayed = result.filter((m) => m.__wskit?.channel === 'replay-room');

    // The opt-out channel stored nothing, so its __replay__ returns no rows.
    expect(optoutReplayed).toEqual([]);
    // The control channel (replay: true) returns its stored history.
    expect(controlReplayed.length).toBeGreaterThan(0);
    expect(
      controlReplayed.some((m) => (m.payload as { text?: string }).text === 'control-live'),
    ).toBe(true);
  });

  test('non-member channel replay request is silently denied (no rows replayed)', async ({
    browser,
  }, testInfo) => {
    const room = `test-${testInfo.testId}-nonmember`;
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    // Client A joins replay-room and posts a message that gets stored.
    await a.goto(`/replay?room=${room}`);
    await a.getByTestId('username-input').fill('alice');
    await a.getByTestId('connect-btn').click();
    await waitForText(a, 'status', 'connected');
    await a.getByTestId('room-join-btn').click();

    await waitForText(a, 'room-subscribed', 'subscribed');
    await a.getByTestId('room-send-btn').click();
    await waitForText(a, 'room-messages', /room hello/);

    // Client B connects to the SAME room namespace but does NOT subscribe
    // to replay-room. B then asks for replay-room history.
    await b.goto(`/replay?room=${room}`);
    await b.getByTestId('username-input').fill('bob');
    await b.getByTestId('connect-btn').click();
    await waitForText(b, 'status', 'connected');
    await b.getByTestId('room-replay-btn').click();

    // Wait long enough that any rows would have arrived. The membership
    // gate must keep room-replay-count at 0 for B.
    await b.waitForTimeout(2000);
    expect(await b.getByTestId('room-replay-count').textContent()).toBe('0');
    expect(await b.getByTestId('room-messages').textContent()).toBe('');

    await ctxA.close();
    await ctxB.close();
  });

  test('sequence persistence across reconnection', async ({ page }) => {
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    await page.getByTestId('send-msg-btn').click();

    await waitForText(page, 'messages', /hello from replay/);
    const oldSeq = Number(await page.getByTestId('last-seq').textContent());
    expect(oldSeq).toBeGreaterThan(0);

    await page.getByTestId('disconnect-btn').click();
    await waitForText(page, 'status', 'disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');

    await page.getByTestId('send-msg-btn').click();
    await expect(async () => {
      const newSeq = Number(await page.getByTestId('last-seq').textContent());
      expect(newSeq).toBeGreaterThan(oldSeq);
    }).toPass({ timeout: 10_000 });
  });

  test('replay from nonzero since', async ({ page }) => {
    // Each send-msg click produces 1 chat-msg event (ctx.broadcast excludes self
    // by default; only ctx.send reaches the sender). 2 more clicks = 2 more stored
    // messages. Wait until both arrive before sampling seqAfter.
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    const seq1 = Number(await page.getByTestId('last-seq').textContent());

    await page.getByTestId('send-msg-btn').click();
    await page.getByTestId('send-msg-btn').click();
    await expect(async () => {
      const seqAfter = Number(await page.getByTestId('last-seq').textContent());
      expect(seqAfter).toBeGreaterThanOrEqual(seq1 + 2);
    }).toPass({ timeout: 5_000 });
    const seqAfter = Number(await page.getByTestId('last-seq').textContent());

    await page.getByTestId('since-input').fill(String(seq1));
    await page.getByTestId('replay-btn').click();
    await expect(async () => {
      const replayCount = Number(await page.getByTestId('replay-count').textContent());
      expect(replayCount).toBeGreaterThan(0);
      expect(replayCount).toBeLessThanOrEqual(seqAfter - seq1);
    }).toPass({ timeout: 5_000 });
  });

  test('history retention prunes old rows once maxMessages is exceeded', async ({ page }) => {
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      for (let i = 0; i < 110; i += 1) {
        ws?.send(
          JSON.stringify({
            event: 'send-msg',
            payload: { text: `history-${i}` },
          }),
        );
      }
    });
    await waitForText(page, 'messages', /history-109/);

    await page.reload();
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');

    await page.getByTestId('replay-btn').click();
    await expect(async () => {
      const replayCount = Number(await page.getByTestId('replay-count').textContent());
      // maxAgeMs may prune some rows before replay; count is capped at 100 but can be lower.
      expect(replayCount).toBeGreaterThan(0);
      expect(replayCount).toBeLessThanOrEqual(100);
      const messages = await page.getByTestId('messages').textContent();
      // history-0 is always pruned (oldest, below the 100-row cap).
      expect(messages).not.toContain('history-0');
      // history-109 is always the newest row and must survive.
      expect(messages).toContain('history-109');
    }).toPass({ timeout: 10_000 });
  });

  test('strict durability: send then immediate disconnect survives and replays', async ({
    page,
  }) => {
    // Queue the last send and disconnect on the same tick so the client never
    // waits for the server roundtrip. Strict durability must still persist it.
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(JSON.stringify({ event: 'send-msg', payload: { text: 'strict-last-send' } }));
    });
    await page.getByTestId('disconnect-btn').click();
    await waitForText(page, 'status', 'disconnected');

    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');
    await page.getByTestId('replay-btn').click();
    await expect(async () => {
      const messages = await page.getByTestId('messages').textContent();
      expect(messages).toContain('strict-last-send');
    }).toPass({ timeout: 10_000 });
  });

  test('reconnect then replay with old seq returns only messages after it', async ({ page }) => {
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(JSON.stringify({ event: 'send-msg', payload: { text: 'preseq-1' } }));
      ws?.send(JSON.stringify({ event: 'send-msg', payload: { text: 'preseq-2' } }));
      ws?.send(JSON.stringify({ event: 'send-msg', payload: { text: 'preseq-3' } }));
    });
    await waitForText(page, 'messages', /preseq-3/);
    await expect(async () => {
      const seq = Number(await page.getByTestId('last-seq').textContent());
      expect(seq).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });
    const oldSeq = Number(await page.getByTestId('last-seq').textContent());

    await page.getByTestId('disconnect-btn').click();
    await waitForText(page, 'status', 'disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(JSON.stringify({ event: 'send-msg', payload: { text: 'postseq-1' } }));
    });
    await waitForText(page, 'messages', /postseq-1/);

    await page.getByTestId('since-input').fill(String(oldSeq));
    await page.getByTestId('replay-btn').click();

    await expect(async () => {
      const replayCount = Number(await page.getByTestId('replay-count').textContent());
      expect(replayCount).toBeGreaterThan(0);
      const messages = await page.getByTestId('messages').textContent();
      expect(messages).toContain('postseq-1');
    }).toPass({ timeout: 10_000 });

    // The replayed slice must only contain messages strictly after oldSeq.
    // Since each send-msg produces 2 stored chat-msgs (ctx.send + ctx.broadcast),
    // one post-disconnect send-msg yields exactly 2 replay rows.
    const replayCount = Number(await page.getByTestId('replay-count').textContent());
    expect(replayCount).toBeLessThanOrEqual(2);
  });

  test('history retention prunes rows older than maxAgeMs', async ({ page }) => {
    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'send-msg',
          payload: { text: 'history-expired' },
        }),
      );
    });
    await waitForText(page, 'messages', /history-expired/);
    await page.waitForTimeout(1200);

    await page.evaluate(() => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      ws?.send(
        JSON.stringify({
          event: 'send-msg',
          payload: { text: 'history-fresh' },
        }),
      );
    });
    await waitForText(page, 'messages', /history-fresh/);

    await page.reload();
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');

    await page.getByTestId('replay-btn').click();
    await expect(async () => {
      const messages = await page.getByTestId('messages').textContent();
      expect(messages).toContain('history-fresh');
      expect(messages).not.toContain('history-expired');
    }).toPass({ timeout: 10_000 });
  });

  test('ctx.sendReplay rejects an undeclared event', async ({ page }) => {
    // ctx.sendReplay runs the same declaration check as ctx.send — resending
    // an event the scope never declared is rejected.
    await page.getByTestId('trigger-bad-replay-btn').click();
    await expect(page.getByTestId('replay-guard-undeclared')).toContainText(
      'not declared in the active scope',
    );
    // Sanity: the rejected send did not break the connection. A real
    // ctx.sendReplay still works.
    await page.getByTestId('request-history-btn').click();
    await waitForText(page, 'history-injected', 'true');
  });

  test('ctx.sendReplay with a non-serializable payload sends __error__ and keeps the loop running', async ({
    page,
  }) => {
    // Pre-fix the BigInt payload threw inside JSON.stringify and the
    // throw escaped the replay caller's loop. The client lost the
    // failing row AND every row queued after it. Post-fix the engine
    // logs and emits a sanitized __error__ frame keeping the routing
    // markers, then returns so the caller's loop keeps iterating.
    await page.getByTestId('trigger-bigint-replay-btn').click();

    // The bad row is replaced by an __error__ carrying the original
    // messageId so the client can correlate the failure.
    await waitForText(page, 'bigint-replay-error', 'internal-error');
    await waitForText(page, 'bigint-replay-error-message-id', 'bigint-row-1');

    // The follow-up row in the same handler must still arrive — the
    // loop did not abort on the bad row.
    await waitForText(page, 'after-bigint-row-delivered', 'true');

    // Connection still healthy: a normal request-history call still works.
    await page.getByTestId('request-history-btn').click();
    await waitForText(page, 'history-injected', 'true');
  });
});
