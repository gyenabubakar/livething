import { channels, client, connect, dedup, gaps, reconnection, replay } from '@wskit/client';
import type { ReplayGapClient } from '@wskit/tests-e2e-handlers/replay-gap';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives gaps() against the real replay server definition, which keeps only
// the newest row per store (maxMessages: 1). A witness publishes while the
// subject is offline, evicting the subject's last-known row; on reconnect the
// server sends __gap__ before the surviving rows, and onGap fires with the
// eviction watermark.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="send-m1">send-m1</button>
    <button data-testid="send-m2">send-m2</button>
    <button data-testid="send-m3">send-m3</button>
    <button data-testid="sub-room">sub-room</button>
    <button data-testid="room-r1">room-r1</button>
    <button data-testid="room-r2">room-r2</button>
    <button data-testid="room-r3">room-r3</button>
    <button data-testid="drop">drop</button>
    <button data-testid="resume-reconnect">resume-reconnect</button>
    <span data-testid="status"></span>
    <span data-testid="reconnect-held"></span>
    <span data-testid="reconnects"></span>
    <span data-testid="messages"></span>
    <span data-testid="room-subscribed"></span>
    <span data-testid="room-messages"></span>
    <span data-testid="gap"></span>
    <span data-testid="gap-count"></span>
    <span data-testid="room-gap"></span>
    <span data-testid="room-gap-count"></span>
  `);

  const url = wsUrl('replay-gap');
  let holdReconnect = false;
  let resumeReconnect: (() => void) | null = null;

  const socket = client<ReplayGapClient>()(
    connect(() => {
      if (!holdReconnect) return url;

      el('reconnect-held').textContent = 'yes';
      return new Promise<string>((resolve) => {
        resumeReconnect = () => {
          holdReconnect = false;
          resumeReconnect = null;
          el('reconnect-held').textContent = 'no';
          resolve(url);
        };
      });
    }),
    replay(),
    gaps(),
    dedup(),
    channels(),
    reconnection({ maxDelay: 400 }),
  );

  const room = socket.channel('gap-room');

  function append(testid: string, value: string): void {
    const span = el(testid);
    span.textContent = span.textContent ? `${span.textContent},${value}` : value;
  }

  function increment(testid: string): void {
    const span = el(testid);
    span.textContent = String(Number(span.textContent) + 1);
  }

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  let reconnects = 0;
  socket.onReconnect(() => {
    reconnects += 1;
    el('reconnects').textContent = String(reconnects);
  });

  socket.on('chat-msg', (msg) => append('messages', msg.text));
  room.on('room-msg', (msg) => append('room-messages', msg.text));

  socket.onGap((info) => {
    append('gap', String(info.missedThrough));
    increment('gap-count');
  });
  room.onGap((info) => {
    append('room-gap', String(info.missedThrough));
    increment('room-gap-count');
  });

  button('connect', () => socket.connect());
  button('send-m1', () => {
    socket.send('send-msg', { text: 'm1' });
  });
  button('send-m2', () => {
    socket.send('send-msg', { text: 'm2' });
  });
  button('send-m3', () => {
    socket.send('send-msg', { text: 'm3' });
  });

  button('sub-room', async () => {
    await room.subscribe();
    el('room-subscribed').textContent = 'yes';
  });
  button('room-r1', () => {
    room.send('send-room-msg', { text: 'r1' });
  });
  button('room-r2', () => {
    room.send('send-room-msg', { text: 'r2' });
  });
  button('room-r3', () => {
    room.send('send-room-msg', { text: 'r3' });
  });

  button('drop', () => {
    holdReconnect = true;
    el('reconnect-held').textContent = 'no';
    socket.send('server-drop', {});
  });
  button('resume-reconnect', () => resumeReconnect?.());

  el('reconnects').textContent = '0';
  el('gap-count').textContent = '0';
  el('room-gap-count').textContent = '0';
  ready();
}

setup();
