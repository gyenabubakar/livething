import { channels, client, connect, dedup, reconnection, replay } from '@wskit/client';
import type { ReplayClient } from '@wskit/tests-e2e-handlers/replay-history';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's replay() against the real `replay` handler (log-mode
// replay, plus a replay-enabled channel). Proves the client catches up on
// frames missed while disconnected — top-level AND channel-scoped — by sending
// __replay__ on reconnect, typed by the same contract the server implements.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="send-m1">send-m1</button>
    <button data-testid="send-m2">send-m2</button>
    <button data-testid="send-m3">send-m3</button>
    <button data-testid="sub-room">sub-room</button>
    <button data-testid="room-r1">room-r1</button>
    <button data-testid="room-r2">room-r2</button>
    <button data-testid="ping-plugin">ping-plugin</button>
    <button data-testid="drop">drop</button>
    <span data-testid="status"></span>
    <span data-testid="reconnects"></span>
    <span data-testid="messages"></span>
    <span data-testid="plugin-messages"></span>
    <span data-testid="room-subscribed"></span>
    <span data-testid="room-messages"></span>
  `);

  // replay() is listed before channels() on purpose: replay declares
  // `optionalAfter: ['channels']`, so on reconnect the channel re-subscribe must
  // still go out before the per-channel __replay__ (or the membership gate drops
  // it). Listing replay first guards that the ordering doesn't depend on how the
  // primitives are registered.
  const socket = client<ReplayClient>()(
    connect(wsUrl('replay')),
    replay(),
    dedup(),
    channels(),
    // Short backoff: long enough for the spec to catch 'reconnecting' and let a
    // witness publish while we're down, short enough to replay before the
    // handler's maxAgeMs=1000 prunes the rows.
    reconnection({ maxDelay: 400 }),
  );

  const room = socket.channel('replay-room');

  function append(testid: string, value: string): void {
    const span = el(testid);
    span.textContent = span.textContent ? `${span.textContent},${value}` : value;
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
  // A plugin-owned event reaches a typed client under its `__<id>::` wire prefix.
  socket.on('__e2e:replay::plugin-msg', (msg) => append('plugin-messages', msg.text));

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
  button('ping-plugin', () => {
    socket.send('__e2e:replay::ping-all', { text: 'p1' });
  });

  button('drop', () => {
    socket.send('server-drop', {});
  });

  el('reconnects').textContent = '0';
  ready();
}

setup();
