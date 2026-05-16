import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

function waitForText(page: Page, testId: string, expected: string | RegExp, timeout = 10_000) {
  return expect(page.getByTestId(testId)).toHaveText(expected, { timeout });
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

  test('private request responses are not stored or resent on _replay', async ({ page }) => {
    // Pre-fix the replay store persisted any outgoing frame including
    // ctx.respond(...) responses (which carry _correlationId). A different
    // client could later send _replay { since: 0 } and receive somebody
    // else's request response.
    //
    // Send a request, receive the response, then ask for replay since 0
    // and assert nothing comes back with a _correlationId field.
    const result = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');
      const got: { event: string; payload: Record<string, unknown> }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') got.push(JSON.parse(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };
      // Send a request with a correlationId. The handler responds with a token.
      ws.send(
        JSON.stringify({
          event: 'get-token',
          payload: { _correlationId: 'req-test-1' },
        }),
      );
      await new Promise((r) => setTimeout(r, 200));
      // Ask for full replay history.
      ws.send(JSON.stringify({ event: '_replay', payload: { since: 0 } }));
      await new Promise((r) => setTimeout(r, 400));
      ws.onmessage = original;
      return got;
    });

    // The response itself was delivered to the original requester.
    const directResponse = result.find(
      (m) => m.event === 'get-token' && m.payload._correlationId === 'req-test-1',
    );
    expect(directResponse).toBeDefined();
    expect(directResponse!.payload.token).toBe('secret-for-testuser');

    // No replayed frame should carry a _correlationId.
    const replayedWithCorrelationId = result.filter(
      (m) =>
        m.event === 'get-token' &&
        typeof m.payload._correlationId === 'string' &&
        m.payload._correlationId !== 'req-test-1',
    );
    expect(replayedWithCorrelationId).toEqual([]);

    // Stronger check: the response must not be replayed at all. The original
    // arrived once (above); if replay had stored it, we would see it twice.
    const allGetTokenFrames = result.filter((m) => m.event === 'get-token');
    expect(allGetTokenFrames).toHaveLength(1);
  });

  test('malformed since on _replay surfaces _error with code "validation-failed"', async ({
    page,
  }) => {
    // Pre-fix the protocol handler ran `Number(payload?.since ?? 0)` which
    // happily turned a non-numeric "since" into NaN and bound that into the
    // SQL query. NaN compares false against every row, so the client got
    // zero rows back and no signal that its frame was malformed. The
    // protocol handler now rejects anything that is not a non-negative
    // integer with a typed validation error, surfaced on the wire as
    // `_error { code: 'validation-failed' }`.
    const errors = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');
      const got: { event: string; payload: Record<string, unknown> }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') got.push(JSON.parse(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };
      ws.send(JSON.stringify({ event: '_replay', payload: { since: 'abc' } }));
      await new Promise((r) => setTimeout(r, 300));
      ws.onmessage = original;
      return got.filter((m) => m.event === '_error');
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.payload.code).toBe('validation-failed');
  });

  test('stream chunks are not persisted into replay and never resend on _replay', async ({
    page,
  }) => {
    // Stream chunks carry `_streamId` so they reach an active stream on
    // the original connection. Replay must not store them: a reconnecting
    // client has no stream by that id, and Issue #3 tracks proper stream
    // replay across reconnect. Pre-fix the persist filter only blocked
    // `_correlationId`, so chunks slipped into `_wskit_replay` and came
    // back on every later `_replay since: 0`.
    const result = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');
      const got: { event: string; payload: Record<string, unknown> }[] = [];
      const original = ws.onmessage;
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') got.push(JSON.parse(ev.data));
        if (typeof original === 'function') original.call(ws, ev);
      };
      ws.send(JSON.stringify({ event: 'start-tiny-stream', payload: {} }));
      await new Promise((r) => setTimeout(r, 300));
      ws.send(JSON.stringify({ event: '_replay', payload: { since: 0 } }));
      await new Promise((r) => setTimeout(r, 400));
      ws.onmessage = original;
      return got;
    });

    // The live chunk reached the original connection (sanity check). The
    // chunk wire event carries the originating event name and a `_streamId`.
    const liveChunks = result.filter(
      (m) => m.event === 'start-tiny-stream' && typeof m.payload._streamId === 'string',
    );
    expect(liveChunks).toHaveLength(1);
    expect(liveChunks[0]!.payload.value).toBe('one');
  });

  test('_replay with _namespace against top-level replay surfaces _error', async ({ page }) => {
    // The fixture registers a namespace called "admin" but only declares
    // top-level replay — namespace replay does not exist as a primitive
    // (issue #8 tracks that work). Pre-fix the protocol handler accepted
    // the request, dropped the namespace marker, and read the unscoped
    // store. The client either got zero rows (when the namespace had its
    // own traffic) or top-level rows mis-tagged as namespace history.
    // Post-fix the handler rejects the request with a typed validation
    // error so the client learns the request cannot be served.
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
        JSON.stringify({
          event: '_replay',
          payload: { since: 0, _namespace: 'admin' },
        }),
      );
      await new Promise((r) => setTimeout(r, 300));
      ws.onmessage = original;
      return got.filter((m) => m.event === '_error');
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.payload.code).toBe('validation-failed');
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
          payload: { text: 'room-old-1', _channel: 'replay-room' },
        }),
      );
      ws?.send(
        JSON.stringify({
          event: 'send-room-msg',
          payload: { text: 'room-old-2', _channel: 'replay-room' },
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
          payload: { text: 'room-new-1', _channel: 'replay-room' },
        }),
      );
      ws?.send(
        JSON.stringify({
          event: 'send-room-msg',
          payload: { text: 'room-new-2', _channel: 'replay-room' },
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
          event: '_replay',
          payload: { since, _channel: 'replay-room' },
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

  test('top-level ctx.sendReplay forwards channelScope onto the wire (built-in replay)', async ({
    page,
  }) => {
    // Pre-fix the built-in replay primitive's top-level sendReplay
    // hardcoded channelScope=null. A handler that injects a family-scoped
    // history frame (channel='fam-1', channelScope='fams') was producing
    // a wire frame with _channel='fam-1' but no _channelScope='fams', so
    // client-side family routing could not place it.
    const frame = await page.evaluate(async () => {
      const ws = (window as unknown as { __ws?: WebSocket }).__ws;
      if (!ws) throw new Error('socket not exposed');
      const got: { event: string; payload: Record<string, unknown> }[] = [];
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
    expect(frame!.payload._channel).toBe('fam-1');
    expect(frame!.payload._channelScope).toBe('fams');
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

  test('ctx.sendReplay enforces declaration + reserved-field guard', async ({ page }) => {
    // Pre-fix ctx.sendReplay only checked the payload was an object. A handler
    // could resend an undeclared event or pass a user `_`-prefixed field that
    // collides with engine wire metadata. Both checks now match ctx.send.
    await page.getByTestId('trigger-bad-replay-btn').click();
    await expect(page.getByTestId('replay-guard-undeclared')).toContainText(
      'not declared in the active scope',
    );
    await expect(page.getByTestId('replay-guard-reserved-field')).toContainText(
      'reserved for the engine',
    );
    // Sanity: the rejected sends did not break the connection. A real
    // ctx.sendReplay still works.
    await page.getByTestId('request-history-btn').click();
    await waitForText(page, 'history-injected', 'true');
  });

  test('ctx.sendReplay with a non-serializable payload sends _error and keeps the loop running', async ({
    page,
  }) => {
    // Pre-fix the BigInt payload threw inside JSON.stringify and the
    // throw escaped the replay caller's loop. The client lost the
    // failing row AND every row queued after it. Post-fix the engine
    // logs and emits a sanitized _error frame keeping the routing
    // markers, then returns so the caller's loop keeps iterating.
    await page.getByTestId('trigger-bigint-replay-btn').click();

    // The bad row is replaced by an _error carrying the original
    // _messageId so the client can correlate the failure.
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
