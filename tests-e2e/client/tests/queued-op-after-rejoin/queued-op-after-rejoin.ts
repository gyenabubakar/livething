import { buffering, channels, client, connect, reconnection } from '@wskit/client';
import type { PersistenceClient } from '@wskit/tests-e2e-handlers/persistence';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client against the real `persistence` server definition to prove the
// reconnect ordering fix: a channel send queued while the socket is reconnecting
// reaches the server only AFTER the channel is rejoined. If the send raced ahead
// of the rejoin the server would drop it (ChannelNotSubscribed) and a witness
// client would never receive the broadcast.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="sub-archive">sub-archive</button>
    <button data-testid="server-drop">server-drop</button>
    <button data-testid="resume-reconnect">resume-reconnect</button>
    <button data-testid="queued-send">queued-send</button>
    <span data-testid="status"></span>
    <span data-testid="reconnect-held"></span>
    <span data-testid="archive-subscribed"></span>
    <span data-testid="room-messages"></span>
  `);

  const url = wsUrl('persistence');
  let holdReconnect = false;
  let resumeReconnect: (() => void) | null = null;

  const socket = client<PersistenceClient>()(
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
    channels(),
    reconnection(),
    // Buffering holds the channel send made while reconnecting; its flush runs in
    // the open phase, which the fix orders AFTER the channel rejoin.
    buffering({ enabled: true }),
  );

  const archive = socket.channel('archive-room');

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  archive.on('room-message', (msg) => {
    const line = `${msg.from}:${msg.text}`;
    const span = el('room-messages');
    span.textContent = span.textContent ? `${span.textContent},${line}` : line;
  });

  button('connect', () => socket.connect());

  button('sub-archive', async () => {
    await archive.subscribe();
    el('archive-subscribed').textContent = 'yes';
  });

  button('server-drop', () => {
    holdReconnect = true;
    el('reconnect-held').textContent = 'no';
    socket.send('server-drop', {});
  });
  button('resume-reconnect', () => resumeReconnect?.());

  // Called while reconnecting — the channel send is queued and must reach the
  // server only after the rejoin __subscribe__.
  button('queued-send', () => {
    archive.send('send-message', { text: 'queued-after-rejoin' });
  });

  ready();
}

setup();
