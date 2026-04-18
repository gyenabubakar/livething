import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type WireMsg = { event: string; payload: Record<string, unknown> };

async function openWs(page: Page, path: string, username: string, room: string) {
  await page.evaluate(
    async ({ path, username, room }) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({ username, room });
      const url = `${protocol}//${location.host}${path}?${params.toString()}`;

      const ws = new WebSocket(url);
      const messages: { event: string; payload: Record<string, unknown> }[] = [];

      (window as unknown as { __testWs: WebSocket }).__testWs = ws;
      (window as unknown as { __testMessages: typeof messages }).__testMessages = messages;
      (window as unknown as { __testCursor: number }).__testCursor = 0;
      (window as unknown as { __testClose?: { code: number; reason: string } }).__testClose =
        undefined;

      ws.onclose = (ev) => {
        (window as unknown as { __testClose?: { code: number; reason: string } }).__testClose = {
          code: ev.code,
          reason: ev.reason,
        };
      };

      ws.onmessage = (event) => {
        if (event.data === 'pong' || typeof event.data !== 'string') return;
        try {
          const parsed = JSON.parse(event.data) as {
            event: string;
            payload: Record<string, unknown>;
          };
          messages.push({ event: parsed.event, payload: parsed.payload });
        } catch {
          // ignore
        }
      };

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('ws failed to open'));
      });
    },
    { path, username, room },
  );
}

async function wsSend(page: Page, event: string, payload: Record<string, unknown>) {
  await page.evaluate(
    ({ event, payload }) => {
      const ws = (window as unknown as { __testWs: WebSocket }).__testWs;
      ws.send(JSON.stringify({ event, payload }));
    },
    { event, payload },
  );
}

async function wsSendBinary(page: Page, bytes: number[]) {
  await page.evaluate((bytes) => {
    const ws = (window as unknown as { __testWs: WebSocket }).__testWs;
    ws.send(new Uint8Array(bytes));
  }, bytes);
}

/**
 * Waits for the next message (since the cursor) matching the predicate.
 * Advances the cursor past the match so repeated waits don't refind old messages.
 */
async function waitForNext(
  page: Page,
  predicate: (m: WireMsg) => boolean,
  timeout = 5_000,
): Promise<WireMsg> {
  return page.evaluate(
    async ({ predicateSource, timeout }) => {
      const win = window as unknown as {
        __testMessages: WireMsg[];
        __testCursor: number;
      };
      // eslint-disable-next-line no-new-func
      const predicate = new Function('m', `return (${predicateSource})(m);`) as (
        m: WireMsg,
      ) => boolean;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        for (let i = win.__testCursor; i < win.__testMessages.length; i++) {
          if (predicate(win.__testMessages[i]!)) {
            win.__testCursor = i + 1;
            return win.__testMessages[i]!;
          }
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('timeout waiting for message');
    },
    { predicateSource: predicate.toString(), timeout },
  );

  type WireMsg = { event: string; payload: Record<string, unknown> };
}

async function waitForClose(
  page: Page,
  timeout = 5_000,
): Promise<{ code: number; reason: string }> {
  return page.evaluate(async (timeout) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const info = (window as unknown as { __testClose?: { code: number; reason: string } })
        .__testClose;
      if (info) return info;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timeout waiting for ws close');
  }, timeout);
}

async function closeWs(page: Page) {
  await page.evaluate(() => {
    const ws = (window as unknown as { __testWs: WebSocket }).__testWs;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  });
}

test.describe('extra server-feature coverage', () => {
  test('channel pre-intercept blocks a message before the handler runs', async ({ page }, info) => {
    const room = `xcov-pre-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'interceptuser', room);

    await wsSend(page, '_subscribe', { _channel: 'chat' });
    await waitForNext(page, (m) => m.event === '_subscribeOk');

    await wsSend(page, 'send-chat', { text: 'channel-pre-block', _channel: 'chat' });
    await page.waitForTimeout(400);

    const sawBlocked = await page.evaluate(() => {
      const msgs = (window as unknown as { __testMessages: WireMsg[] }).__testMessages;
      return msgs.some(
        (m) =>
          m.event === 'chat-message' &&
          (m.payload as { text?: string }).text === 'channel-pre-block',
      );
      type WireMsg = { event: string; payload: Record<string, unknown> };
    });
    expect(sawBlocked).toBe(false);

    await wsSend(page, 'send-chat', { text: 'ok-message', _channel: 'chat' });
    const delivered = await waitForNext(
      page,
      (m) => m.event === 'chat-message' && (m.payload as { text?: string }).text === 'ok-message',
    );
    expect(delivered.payload.text).toBe('ok-message');

    await closeWs(page);
  });

  test('dynamic channel scope matches arbitrary suffixes and exposes the full name', async ({
    page,
  }, info) => {
    const room = `xcov-dyn-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'paramuser', room);

    await wsSend(page, '_subscribe', { _channel: 'room:alpha-123', _channelScope: 'rooms' });
    await waitForNext(page, (m) => m.event === '_subscribeOk');

    await wsSend(page, 'room-echo-param', {
      _channel: 'room:alpha-123',
      _channelScope: 'rooms',
    });
    const result = await waitForNext(page, (m) => m.event === 'room-param-result');
    expect(result.payload.name).toBe('room:alpha-123');
    expect(result.payload.suffix).toBe('alpha-123');

    await closeWs(page);
  });

  test('async onBeforeSubscribe rejection prevents subscription', async ({ page }, info) => {
    const room = `xcov-async-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'async-banned-user', room);

    await wsSend(page, '_subscribe', { _channel: 'room:denied', _channelScope: 'rooms' });

    const failure = await waitForNext(page, (m) => m.event === '_error');
    expect(failure).toBeTruthy();

    await closeWs(page);
  });

  test('subscribe to a non-matching channel name emits _error channel-not-found', async ({
    page,
  }, info) => {
    const room = `xcov-nomatch-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'unknownuser', room);

    await wsSend(page, '_subscribe', { _channel: 'does-not-exist' });

    const err = await waitForNext(page, (m) => m.event === '_error');
    const payload = err.payload as { code?: string; _channel?: string; _channelScope?: string };
    expect(payload.code).toBe('channel-not-found');
    expect(payload._channel).toBe('does-not-exist');
    expect(payload._channelScope).toBeUndefined();

    // Connection stays alive — echo roundtrip still works.
    await wsSend(page, 'echo', { text: 'post-noop' });
    const echoed = await waitForNext(
      page,
      (m) => m.event === 'echoed' && (m.payload as { text?: string }).text === 'post-noop',
    );
    expect(echoed.payload.text).toBe('post-noop');

    await closeWs(page);
  });

  test('kv: delete removes a stored value', async ({ page }, info) => {
    const room = `xcov-kvdel-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'kvuser', room);

    await wsSend(page, 'kv-set', { key: 'gone-key', value: 'here' });
    const firstSet = await waitForNext(
      page,
      (m) => m.event === 'kv-result' && m.payload.key === 'gone-key',
    );
    expect(firstSet.payload.value).toBe('here');

    await wsSend(page, 'kv-delete', { key: 'gone-key' });
    const afterDelete = await waitForNext(
      page,
      (m) => m.event === 'kv-result' && m.payload.key === 'gone-key',
    );
    expect(afterDelete.payload.value).toBeNull();

    await wsSend(page, 'kv-get', { key: 'gone-key' });
    const afterGet = await waitForNext(
      page,
      (m) => m.event === 'kv-result' && m.payload.key === 'gone-key',
    );
    expect(afterGet.payload.value).toBeNull();

    await closeWs(page);
  });

  test('kv: set with ttl expires within window', async ({ page }, info) => {
    const room = `xcov-kvttl-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'kvttluser', room);

    await wsSend(page, 'kv-set-ttl', { key: 'ttl-key', value: 'ephemeral', ttlMs: 300 });
    await waitForNext(page, (m) => m.event === 'kv-result' && m.payload.key === 'ttl-key');

    await page.waitForTimeout(900);

    await wsSend(page, 'kv-get', { key: 'ttl-key' });
    const after = await waitForNext(
      page,
      (m) => m.event === 'kv-result' && m.payload.key === 'ttl-key',
    );
    expect(after.payload.value).not.toBe('ephemeral');

    await closeWs(page);
  });

  test('SqlResult.one returns a single row', async ({ page }, info) => {
    const room = `xcov-sqlone-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'sqluser1', room);

    await wsSend(page, 'save-note', { title: 'a', body: 'body-a' });
    await waitForNext(page, (m) => m.event === 'notes-list');

    await wsSend(page, 'sql-one-probe', {});
    const row = await waitForNext(page, (m) => m.event === 'sql-one-result');
    const payload = row.payload as { row: { c: number } | null };
    expect(payload.row).not.toBeNull();
    expect(payload.row!.c).toBeGreaterThanOrEqual(1);

    await closeWs(page);
  });

  test('SqlResult.raw returns array-of-arrays rows', async ({ page }, info) => {
    const room = `xcov-sqlraw-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'sqluser2', room);

    await wsSend(page, 'save-note', { title: 'raw-title', body: 'raw-body' });
    await waitForNext(page, (m) => m.event === 'notes-list');

    await wsSend(page, 'sql-raw-probe', {});
    const raw = await waitForNext(page, (m) => m.event === 'sql-raw-result');
    const rows = (raw.payload as { rows: unknown[][] }).rows;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(rows[0])).toBe(true);

    await closeWs(page);
  });

  test('module typed error reaches the client', async ({ page }, info) => {
    const room = `xcov-moderr-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws/modules', 'moderruser', room);

    await wsSend(page, 'trigger-module-denied', {});
    const err = await waitForNext(
      page,
      (m) => m.event === '_error' && (m.payload as { code?: string }).code === 'e2e-drizzle/denied',
    );
    const payload = err.payload as { code: string; detail?: { reason?: string; op?: string } };
    expect(payload.code).toBe('e2e-drizzle/denied');
    expect(payload.detail?.reason).toBe('test denial');
    expect(payload.detail?.op).toBe('insert');

    await closeWs(page);
  });

  test('ack is not emitted when handler throws', async ({ page }, info) => {
    const room = `xcov-ackthrow-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'ackthrowuser', room);

    await wsSend(page, 'echo', { text: 'baseline', _ackId: 'ack-baseline' });
    await waitForNext(page, (m) => m.event === '_ack');

    await wsSend(page, 'ack-then-throw', { _ackId: 'ack-throw' });

    const gotThrowAck = await page.evaluate(async () => {
      const msgs = (window as unknown as { __testMessages: WireMsg[] }).__testMessages;
      await new Promise((r) => setTimeout(r, 500));
      return msgs.some(
        (m) => m.event === '_ack' && (m.payload as { _ackId?: string })._ackId === 'ack-throw',
      );
      type WireMsg = { event: string; payload: Record<string, unknown> };
    });
    expect(gotThrowAck).toBe(false);

    await closeWs(page);
  });

  test('onBinary can access ctx.meta (username)', async ({ page }, info) => {
    const room = `xcov-binmeta-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'binarymeta', room);

    await wsSendBinary(page, [1, 2, 3, 4, 5]);

    const result = await waitForNext(page, (m) => m.event === 'binary-meta');
    expect(result.payload.size).toBe(5);
    expect(result.payload.username).toBe('binarymeta');

    await closeWs(page);
  });

  test('onShutdown broadcasts user-left to all connected clients', async ({ browser }, info) => {
    const room = `xcov-shutdown-${info.testId}`;
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    const pageB = await ctx.newPage();
    await pageA.goto('/');
    await pageB.goto('/');

    await openWs(pageA, '/ws', 'shutA', room);
    await openWs(pageB, '/ws', 'shutB', room);

    await pageA.request.post(`/ws/shutdown?room=${room}`);

    const aLeft = await waitForNext(
      pageA,
      (m) => m.event === 'user-left' && m.payload.username === 'server-shutdown',
      10_000,
    );
    const bLeft = await waitForNext(
      pageB,
      (m) => m.event === 'user-left' && m.payload.username === 'server-shutdown',
      10_000,
    );
    expect(aLeft.payload.username).toBe('server-shutdown');
    expect(bLeft.payload.username).toBe('server-shutdown');

    await ctx.close();
  });

  test('force-disconnect closes wire with code 4009', async ({ page }, info) => {
    const room = `xcov-disc-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'discuser', room);

    await wsSend(page, 'force-disconnect', {});

    const closed = await waitForClose(page, 10_000);
    expect(closed.code).toBe(4009);
  });

  test('server-close delivers the code/reason pair on the wire', async ({ page }, info) => {
    const room = `xcov-srvclose-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'srvcloseuser', room);

    await wsSend(page, 'server-close', { code: 4009, reason: 'test-close' });

    const closed = await waitForClose(page, 10_000);
    expect(closed.code).toBe(4009);
    expect(closed.reason).toBe('test-close');
  });

  test('incoming dedup: identical _messageId is dropped before the handler runs', async ({
    page,
  }, info) => {
    // dedup() guards both directions: OUTGOING messages get a unique _messageId
    // stamped (see the "dedup: outgoing messages have unique _messageId" handler
    // test) and INCOMING frames with a repeated client-supplied _messageId are
    // silently dropped. The handler must only run once even when the frame
    // arrives twice.
    const room = `xcov-dedup-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'dedupuser', room);

    await page.evaluate(() => {
      const ws = (window as unknown as { __testWs: WebSocket }).__testWs;
      const dup = JSON.stringify({
        event: 'echo',
        payload: { text: 'dup-hi', _messageId: 'fixed-123' },
      });
      ws.send(dup);
      ws.send(dup);
    });

    await waitForNext(
      page,
      (m) => m.event === 'echoed' && (m.payload as { text?: string }).text === 'dup-hi',
    );

    // Give the server generous time to dispatch a second echo if it were going to.
    await page.waitForTimeout(500);

    const echoCount = await page.evaluate(
      () =>
        (
          window as unknown as { __testMessages: { event: string; payload: { text?: string } }[] }
        ).__testMessages.filter((m) => m.event === 'echoed' && m.payload.text === 'dup-hi').length,
    );
    expect(echoCount).toBe(1);

    await closeWs(page);
  });

  test('incoming dedup: frames without _messageId are always dispatched', async ({
    page,
  }, info) => {
    // Opt-out path — clients that don't attach a _messageId keep at-least-once
    // semantics so intentional repeats (e.g. heartbeat pings, cursor updates)
    // still reach their handlers.
    const room = `xcov-dedup-noid-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'noid-user', room);

    await page.evaluate(() => {
      const ws = (window as unknown as { __testWs: WebSocket }).__testWs;
      const frame = JSON.stringify({ event: 'echo', payload: { text: 'no-id' } });
      ws.send(frame);
      ws.send(frame);
    });

    await waitForNext(
      page,
      (m) => m.event === 'echoed' && (m.payload as { text?: string }).text === 'no-id',
    );

    await page.waitForTimeout(500);

    const echoCount = await page.evaluate(
      () =>
        (
          window as unknown as { __testMessages: { event: string; payload: { text?: string } }[] }
        ).__testMessages.filter((m) => m.event === 'echoed' && m.payload.text === 'no-id').length,
    );
    expect(echoCount).toBe(2);

    await closeWs(page);
  });

  test('double _subscribe to chat is idempotent and re-emits _subscribeOk', async ({
    page,
  }, info) => {
    const room = `xcov-dblsub-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'dblsubuser', room);

    await wsSend(page, '_subscribe', { _channel: 'chat' });
    const first = await waitForNext(page, (m) => m.event === '_subscribeOk');
    expect(first.payload._channel).toBe('chat');

    await wsSend(page, '_subscribe', { _channel: 'chat' });
    const second = await waitForNext(page, (m) => m.event === '_subscribeOk');
    expect(second.payload._channel).toBe('chat');

    // Connection stays alive — echo still works.
    await wsSend(page, 'echo', { text: 'after-dblsub' });
    const echoed = await waitForNext(
      page,
      (m) => m.event === 'echoed' && (m.payload as { text?: string }).text === 'after-dblsub',
    );
    expect(echoed.payload.text).toBe('after-dblsub');

    await closeWs(page);
  });

  test('_unsubscribe when not subscribed is a silent no-op', async ({ page }, info) => {
    const room = `xcov-nounsub-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'nounsubuser', room);

    await wsSend(page, '_unsubscribe', { _channel: 'chat' });

    await page.waitForTimeout(500);

    const sawError = await page.evaluate(() =>
      (window as unknown as { __testMessages: { event: string }[] }).__testMessages.some(
        (m) => m.event === '_error',
      ),
    );
    expect(sawError).toBe(false);

    // Connection is still alive.
    await wsSend(page, 'echo', { text: 'post-unsub-noop' });
    const echoed = await waitForNext(
      page,
      (m) => m.event === 'echoed' && (m.payload as { text?: string }).text === 'post-unsub-noop',
    );
    expect(echoed.payload.text).toBe('post-unsub-noop');

    await closeWs(page);
  });

  test('publish to a channel without subscribing is silently dropped', async ({ page }, info) => {
    const room = `xcov-nopub-${info.testId}`;
    await page.goto('/');
    await openWs(page, '/ws', 'nopubuser', room);

    await wsSend(page, 'send-chat', { text: 'no-sub-publish', _channel: 'chat' });

    await page.waitForTimeout(750);

    const sawChatMsg = await page.evaluate(() =>
      (
        window as unknown as {
          __testMessages: { event: string; payload: { text?: string } }[];
        }
      ).__testMessages.some(
        (m) => m.event === 'chat-message' && m.payload.text === 'no-sub-publish',
      ),
    );
    expect(sawChatMsg).toBe(false);

    // Connection is still alive.
    await wsSend(page, 'echo', { text: 'post-nopub' });
    const echoed = await waitForNext(
      page,
      (m) => m.event === 'echoed' && (m.payload as { text?: string }).text === 'post-nopub',
    );
    expect(echoed.payload.text).toBe('post-nopub');

    await closeWs(page);
  });
});
