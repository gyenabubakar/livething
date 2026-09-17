import { channels, client, connect, serverRequests } from '@wskit/client';
import type { BroadcastRequestClient } from '@wskit/tests-e2e-handlers/broadcast-request';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's serverRequests() against the real `broadcast-request`
// server definition, typed by the same contract the server implements
// (BroadcastRequestClient = InferClient<definition>). Members join the `lobby`
// channel; the server fans a broadcast request out to every member and resolves
// with the first valid answer plus the answerer's identity. Each page answers
// per its own mode so a spec can pit a valid answerer against a silent/invalid
// one across two browser contexts.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="subscribe">subscribe</button>
    <button data-testid="answer-good">answer-good</button>
    <button data-testid="answer-bad">answer-bad</button>
    <button data-testid="answer-drop">answer-drop</button>
    <button data-testid="trigger">trigger</button>
    <button data-testid="trigger-timeout">trigger-timeout</button>
    <span data-testid="status"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="last-turn"></span>
    <span data-testid="outcome-from"></span>
    <span data-testid="outcome-ready"></span>
    <span data-testid="error-outcome"></span>
  `);

  const socket = client<BroadcastRequestClient>()(
    connect(wsUrl('broadcast-request')),
    serverRequests(),
    channels(),
  );

  const lobby = socket.channel('lobby');

  let mode: 'good' | 'bad' | 'drop' = 'good';

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  socket.on('outcome', (data) => {
    el('outcome-from').textContent = data.from;
    el('outcome-ready').textContent = String(data.ready);
  });
  socket.on('error-outcome', (data) => {
    el('error-outcome').textContent = data.code;
  });

  // Answer the broadcast question. Records the asked turn so the spec can prove
  // every member was reached, then answers per mode. `volunteer` is a channel
  // request, so it is answered through the channel handle.
  lobby.onRequest('volunteer', (payload) => {
    el('last-turn').textContent = String(payload.turn);
    if (mode === 'drop') return new Promise<{ ready: boolean }>(() => {});

    if (mode === 'bad') return { ready: 'sure' } as unknown as { ready: boolean };

    return { ready: true };
  });

  button('connect', () => socket.connect());
  button('subscribe', async () => {
    await lobby.subscribe();
    el('subscribed').textContent = 'true';
  });
  button('answer-good', () => {
    mode = 'good';
  });
  button('answer-bad', () => {
    mode = 'bad';
  });
  button('answer-drop', () => {
    mode = 'drop';
  });

  button('trigger', () => {
    socket.send('trigger', { turn: 5 });
  });
  button('trigger-timeout', () => {
    socket.send('trigger-timeout', { turn: 9 });
  });

  ready();
}

setup();
