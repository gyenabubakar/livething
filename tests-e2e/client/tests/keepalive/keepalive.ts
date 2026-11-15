import { client, connect, keepalive } from '@livething/client';
import type { KeepaliveClient } from '@livething/tests-e2e-handlers/keepalive';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @livething/client's keepalive() against the real `keepalive`
// server definition, typed by the same contract the server implements
// (KeepaliveClient = InferClient<definition>). The server definition pings every 1s and
// closes after 2s of silence.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <span data-testid="status"></span>
    <span data-testid="latency"></span>
    <span data-testid="quality"></span>
    <span data-testid="quality-changed"></span>
  `);

  const socket = client<KeepaliveClient>()(connect(wsUrl('keepalive')), keepalive());

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
