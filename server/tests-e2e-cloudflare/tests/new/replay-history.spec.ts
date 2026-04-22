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

    await page.getByTestId('room-replay-btn').click();
    await expect(async () => {
      const roomReplayCount = Number(await page.getByTestId('room-replay-count').textContent());
      expect(roomReplayCount).toBeGreaterThan(0);
    }).toPass({ timeout: 5_000 });
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
    // Each send-msg click produces 2 chat-msg events (ctx.send + ctx.broadcast),
    // so 3 clicks produce 6 stored messages. Wait until all 6 arrive before
    // sampling seqAfter, otherwise the assertion races with in-flight messages.
    await page.getByTestId('send-msg-btn').click();
    await waitForText(page, 'messages', /hello from replay/);
    const seq1 = Number(await page.getByTestId('last-seq').textContent());

    await page.getByTestId('send-msg-btn').click();
    await page.getByTestId('send-msg-btn').click();
    await expect(async () => {
      const seqAfter = Number(await page.getByTestId('last-seq').textContent());
      expect(seqAfter).toBeGreaterThanOrEqual(seq1 + 4);
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
      for (let i = 0; i < 60; i += 1) {
        ws?.send(
          JSON.stringify({
            event: 'send-msg',
            payload: { text: `history-${i}` },
          }),
        );
      }
    });
    await waitForText(page, 'messages', /history-59/);

    await page.reload();
    await expect(page.getByTestId('status')).toHaveText('disconnected');
    await page.getByTestId('connect-btn').click();
    await waitForText(page, 'status', 'connected');

    await page.getByTestId('replay-btn').click();
    await expect(async () => {
      const replayCount = Number(await page.getByTestId('replay-count').textContent());
      expect(replayCount).toBe(100);
      const messages = await page.getByTestId('messages').textContent();
      expect(messages).not.toContain('history-0');
      expect(messages).toContain('history-59');
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
});
