import { channels, client, connect } from '@wskit/client';
import { inject, injectChannel } from '@wskit/client/testing';
import type { Socket } from '@wskit/client';
import type { GroupFullSurfaceClient } from '@wskit/tests-e2e-handlers/group-full-surface';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives the @wskit/client/testing helpers — inject / injectChannel — typed
// against a real contract (GroupFullSurfaceClient). The socket is never
// connected: inject runs the local pipeline and dispatches to on() handlers as
// if the server had sent the frame.
export function setup(): void {
  mount(`
    <button data-testid="inject-top">inject-top</button>
    <button data-testid="inject-channel">inject-channel</button>
    <span data-testid="top-result"></span>
    <span data-testid="channel-result"></span>
  `);

  // No socket.connect() — these helpers work while the socket is closed.
  const socket = client<GroupFullSurfaceClient>()(connect(wsUrl('group-full-surface')), channels());

  socket.on('welcome', (p) => {
    el('top-result').textContent = p.username;
  });
  socket.channel('rooms').on('room-msg', (p) => {
    el('channel-result').textContent = `${p.from}:${p.text}`;
  });

  // The cast recovers the contract type: client()'s return type is a flattened
  // intersection, so inject()'s generic can't infer it from the socket alone.
  const typed = socket as Socket<GroupFullSurfaceClient>;
  button('inject-top', () => {
    inject(typed, 'welcome', { username: 'injected' });
  });
  button('inject-channel', () => {
    injectChannel(typed, 'rooms', 'room-msg', { text: 'hi', from: 'sys' });
  });

  ready();
}

setup();
