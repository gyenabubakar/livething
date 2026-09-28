import { client, connect, dedup } from '@livething/client';
import type { DedupClient } from '@livething/tests-e2e-handlers/dedup';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @livething/client's dedup() against the real `dedup` server definition, typed by the
// same contract the server implements (DedupClient = InferClient<definition>). The
// server definition echoes `do-echo` back as `echoed`, and the server stamps every
// outgoing frame with its own fresh messageId, so dedup() sees a distinct id per
// echo and must let each one through.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="echo">echo</button>
    <span data-testid="status"></span>
    <span data-testid="echo-count"></span>
  `);

  const socket = client<DedupClient>()(connect(wsUrl('dedup')), dedup());

  let echoCount = 0;

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.on('echoed', () => {
    echoCount += 1;
    el('echo-count').textContent = String(echoCount);
  });

  button('connect', () => socket.connect());

  button('echo', () => {
    socket.send('do-echo', { text: 'hi' });
  });

  ready();
}

setup();
