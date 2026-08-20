import { channels, client, connect, dedup, inbox, reconnection, replay } from '@wskit/client';
import type { InboxGapClient } from '@wskit/tests-e2e-handlers/inbox-gap';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives inbox OVERFLOW against the real inbox-gap handler (retention keeps one
// undelivered row per member). While a member is offline, a second broadcast
// evicts the first held row and lifts its overflow watermark; on reconnect the
// drain emits `__gap__` before the surviving row. The `?replay=1` variant runs
// replay() and surfaces the gap on room.onGap; the default (inbox-only) variant
// has no gap handler and silently drops the frame — the D1 decision.
export function setup(): void {
  const withReplay = new URLSearchParams(location.search).get('replay') === '1';

  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="disconnect">disconnect</button>
    <button data-testid="sub">sub</button>
    <button data-testid="send-m1">send-m1</button>
    <button data-testid="send-m2">send-m2</button>
    <button data-testid="leave-rejoin">leave-rejoin</button>
    <button data-testid="send-stale-unsubscribe-ok">send-stale-unsubscribe-ok</button>
    <span data-testid="status"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="messages"></span>
    <span data-testid="message-count"></span>
    <span data-testid="rejoined"></span>
    <span data-testid="gap"></span>
    <span data-testid="variant"></span>
  `);
  el('variant').textContent = withReplay ? 'replay' : 'inbox-only';

  const socket = withReplay
    ? client<InboxGapClient>()(
        connect(wsUrl('inbox-gap')),
        channels(),
        inbox(),
        replay(),
        dedup(),
        reconnection({ maxDelay: 400 }),
      )
    : client<InboxGapClient>()(
        connect(wsUrl('inbox-gap')),
        channels(),
        inbox(),
        dedup(),
        reconnection({ maxDelay: 400 }),
      );

  const chat = socket.channel('chat');

  const seen: string[] = [];
  chat.on('room-msg', (msg) => {
    seen.push(msg.text);
    el('messages').textContent = seen.join(',');
    el('message-count').textContent = String(seen.length);
  });

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  // Only the replay variant carries room.onGap.
  if (withReplay) {
    chat.onGap((info) => {
      el('gap').textContent = String(info.missedThrough);
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
  button('send-stale-unsubscribe-ok', () => {
    chat.send('trigger-stale-unsubscribe-ok', {});
  });

  el('message-count').textContent = '0';

  ready();
}

setup();
