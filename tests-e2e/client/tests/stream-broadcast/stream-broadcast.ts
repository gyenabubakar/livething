import { client, connect, stream } from '@wskit/client';
import type { StreamBroadcastClient } from '@wskit/tests-e2e-handlers/stream-broadcast';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's stream() against the real `stream-broadcast` handler.
// One context triggers a broadcast stream with socket.stream(); a peer context
// listens with socket.onStream() and records every chunk via onChunk, the close
// via onEnd, and a terminal generator error via onError — typed by the same
// contract the server implements (StreamBroadcastClient = InferClient<handler>).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="listen">listen</button>
    <button data-testid="start-3">start-3</button>
    <button data-testid="start-boom">start-boom</button>
    <span data-testid="status"></span>
    <span data-testid="trigger-chunks"></span>
    <span data-testid="trigger-end"></span>
    <span data-testid="trigger-error"></span>
    <span data-testid="peer-chunks"></span>
    <span data-testid="peer-end"></span>
    <span data-testid="peer-error"></span>
  `);

  const socket = client<StreamBroadcastClient>()(connect(wsUrl('stream-broadcast')), stream());

  socket.subscribe(() => {
    el('status').textContent = socket.getState();
  });

  function append(testid: string, value: string): void {
    const span = el(testid);
    span.textContent = span.textContent ? `${span.textContent},${value}` : value;
  }

  button('connect', () => socket.connect());

  button('listen', () => {
    socket.onStream('start-broadcast', {
      onChunk: (chunk) => append('peer-chunks', String(chunk.index)),
      onEnd: () => {
        el('peer-end').textContent = 'yes';
      },
      onError: (err) => {
        el('peer-error').textContent = errorCode(err);
      },
    });
  });

  button('start-3', async () => {
    const handle = await socket.stream('start-broadcast', { count: 3 });
    for await (const chunk of handle) append('trigger-chunks', String(chunk.index));
    el('trigger-end').textContent = 'yes';
  });

  button('start-boom', async () => {
    try {
      const handle = await socket.stream('start-broadcast', { count: -1 });
      for await (const chunk of handle) append('trigger-chunks', String(chunk.index));
      el('trigger-end').textContent = 'yes';
    } catch (err) {
      el('trigger-error').textContent = errorCode(err);
    }
  });

  ready();
}

setup();
