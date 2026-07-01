import { client, connect, keepalive, quality } from '@wskit/client';
import type { KeepaliveClient } from '@wskit/tests-e2e-handlers/keepalive';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's keepalive() + quality() against the real `keepalive`
// handler, typed by the same contract the server implements
// (KeepaliveClient = InferClient<handler>). The handler pings every 1s and
// closes after 2s of silence.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <span data-testid="status"></span>
    <span data-testid="latency"></span>
    <span data-testid="quality"></span>
    <span data-testid="quality-changed"></span>
  `);

  const socket = client<KeepaliveClient>()(
    connect(wsUrl('keepalive')),
    keepalive({ interval: 500 }),
    quality(),
  );

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.quality.subscribe((q) => {
    el('quality-changed').textContent = 'yes';
    el('quality').textContent = q;
  });

  socket.latency.subscribe((latency) => {
    if (latency !== null) el('latency').textContent = String(latency);
  });

  button('connect', () => socket.connect());

  ready();
}

setup();
