import { channels, client, connect, dedup, gaps, inbox, reconnection } from '@wskit/client';
import type { InboxGapClient } from '@wskit/tests-e2e-handlers/inbox-gap';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives inbox OVERFLOW against the real inbox-gap handler (retention keeps one
// undelivered row per member). While a member is offline, a second broadcast
// evicts the first held row and lifts its overflow watermark; on reconnect the
// drain emits `__gap__` before the surviving row. The `?gaps=1` variant runs
// gaps() and surfaces the gap on room.onGap; the default (inbox-only) variant
// has no gap handler, but inbox still consumes and acknowledges the frame — the
// D1 decision only hides the gap from application code.
export function setup(): void {
  const withGaps = new URLSearchParams(location.search).get('gaps') === '1';

  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="disconnect">disconnect</button>
    <button data-testid="sub">sub</button>
    <button data-testid="send-m1">send-m1</button>
    <button data-testid="send-m2">send-m2</button>
    <button data-testid="leave-rejoin">leave-rejoin</button>
    <button data-testid="leave-rejoin-stale-race">leave-rejoin-stale-race</button>
    <button data-testid="send-stale-unsubscribe-ok">send-stale-unsubscribe-ok</button>
    <span data-testid="status"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="messages"></span>
    <span data-testid="message-count"></span>
    <span data-testid="rejoined"></span>
    <span data-testid="race-leave-started"></span>
    <span data-testid="race-newer-leave-started"></span>
    <span data-testid="race-stale-delivered"></span>
    <span data-testid="race-receipts-preserved"></span>
    <span data-testid="race-newer-leave-settled"></span>
    <span data-testid="race-rejoined"></span>
    <span data-testid="receivers"></span>
    <span data-testid="gap"></span>
    <span data-testid="gap-count"></span>
    <span data-testid="variant"></span>
  `);
  el('variant').textContent = withGaps ? 'gaps' : 'inbox-only';

  const gapsSocket = withGaps
    ? client<InboxGapClient>()(
        connect(wsUrl('inbox-gap')),
        channels(),
        gaps(),
        inbox(),
        dedup(),
        reconnection({ maxDelay: 400 }),
      )
    : null;
  const socket =
    gapsSocket ??
    client<InboxGapClient>()(
      connect(wsUrl('inbox-gap')),
      channels(),
      inbox(),
      dedup(),
      reconnection({ maxDelay: 400 }),
    );

  const chat = socket.channel('chat');

  const unsubscribeFrames: string[] = [];
  const nativeSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string') {
      try {
        const frame = JSON.parse(data) as { event?: unknown };
        if (frame.event === '__unsubscribe__') unsubscribeFrames.push(data);
      } catch {
        // The socket still sends the original frame; only the test capture is skipped.
      }
    }
    return nativeSend.call(this, data);
  };

  const hookStarted = new Map<number, () => void>();
  const hookFinished = new Map<number, () => void>();
  socket.on('race-leave-hook-started', ({ attempt }) => hookStarted.get(attempt)?.());
  socket.on('race-leave-hook-finished', ({ attempt }) => hookFinished.get(attempt)?.());

  function waitForHook(map: Map<number, () => void>, attempt: number): Promise<void> {
    return new Promise((resolve) => map.set(attempt, resolve));
  }

  function releaseRaceLeave(attempt: number): void {
    socket.send('release-race-leave', { attempt });
  }

  const seen: string[] = [];
  chat.on('room-msg', (msg) => {
    seen.push(msg.text);
    el('messages').textContent = seen.join(',');
    el('message-count').textContent = String(seen.length);
  });

  function renderReceivers(): void {
    el('receivers').textContent = [...chat.receivers.get()]
      .map(([userId, receivedThrough]) => `${userId}=${receivedThrough}`)
      .join(',');
  }
  chat.receivers.subscribe(renderReceivers);
  renderReceivers();

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  // Only the gaps variant carries room.onGap.
  if (gapsSocket) {
    gapsSocket.channel('chat').onGap((info) => {
      el('gap').textContent = String(info.missedThrough);
      el('gap-count').textContent = String(Number(el('gap-count').textContent ?? '0') + 1);
    });
  }

  button('connect', () => socket.connect());
  button('disconnect', () => socket.disconnect());
  button('sub', async () => {
    await chat.subscribe();
    el('subscribed').textContent = 'yes';
  });
  button('send-m1', () => {
    chat.send('send-room-msg', { text: 'm1' });
  });
  button('send-m2', () => {
    chat.send('send-room-msg', { text: 'm2' });
  });
  button('leave-rejoin', async () => {
    await chat.unsubscribe();
    await chat.subscribe();
    el('rejoined').textContent = 'yes';
  });
  button('leave-rejoin-stale-race', async () => {
    const firstHook = waitForHook(hookStarted, 1);
    const leave = chat.unsubscribe();
    const firstRejoin = chat.subscribe();
    el('race-leave-started').textContent = 'yes';
    await firstHook;

    // The duplicate is a real wire resend. The server has already removed the
    // membership before the first leave hook finishes, so it returns an early
    // confirmation with the same id while the original reply remains delayed.
    const firstFrame = unsubscribeFrames.at(-1);
    if (!firstFrame) throw new Error('missing first unsubscribe frame');
    socket.ws?.send(firstFrame);

    await leave;
    await firstRejoin;

    const secondHook = waitForHook(hookStarted, 2);
    let newerLeaveSettled = false;
    const newerLeave = chat.unsubscribe();
    void newerLeave.then(() => {
      newerLeaveSettled = true;
    });
    el('race-newer-leave-started').textContent = 'yes';
    await secondHook;

    // Release the original leave only after leave two is waiting. Its old id
    // must be consumed without settling the newer public leave promise.
    releaseRaceLeave(1);
    await waitForHook(hookFinished, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    el('race-stale-delivered').textContent = newerLeaveSettled ? 'no' : 'yes';
    el('race-receipts-preserved').textContent = chat.receivers.get().size > 0 ? 'yes' : 'no';
    await new Promise((resolve) => setTimeout(resolve, 250));

    releaseRaceLeave(2);
    await newerLeave;
    el('race-newer-leave-settled').textContent = 'yes';
    await chat.subscribe();
    el('race-rejoined').textContent = 'yes';
  });
  button('send-stale-unsubscribe-ok', () => {
    chat.send('trigger-stale-unsubscribe-ok', {});
  });

  el('message-count').textContent = '0';
  el('gap-count').textContent = '0';
  el('race-leave-started').textContent = '';
  el('race-newer-leave-started').textContent = '';
  el('race-stale-delivered').textContent = '';
  el('race-receipts-preserved').textContent = '';
  el('race-newer-leave-settled').textContent = '';
  el('race-rejoined').textContent = '';

  ready();
}

setup();
