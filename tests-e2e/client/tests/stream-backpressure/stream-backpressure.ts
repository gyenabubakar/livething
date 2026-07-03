import { client, connect, stream } from '@wskit/client';
import type { StreamBackpressureClient } from '@wskit/tests-e2e-handlers/stream-backpressure';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's stream() against the real `stream-backpressure`
// handler, typed by the same contract the server implements
// (StreamBackpressureClient = InferClient<handler>). The generator awaits
// ctx.stream.drain() after every yield; on Cloudflare drain is a no-op, so the
// stream must still deliver every chunk and end cleanly — never hang on drain.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="start-5">start-5</button>
    <span data-testid="status"></span>
    <span data-testid="stream-ok"></span>
    <span data-testid="chunk-indices"></span>
    <span data-testid="stream-end"></span>
  `);

  const socket = client<StreamBackpressureClient>()(
    connect(wsUrl('stream-backpressure')),
    stream(),
  );

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  button('connect', () => socket.connect());

  button('start-5', async () => {
    el('chunk-indices').textContent = '';
    el('stream-end').textContent = 'no';
    const handle = await socket.stream('drain-feed', { count: 5 });
    el('stream-ok').textContent = 'yes';
    const indices: number[] = [];
    for await (const chunk of handle) {
      indices.push(chunk.index);
      el('chunk-indices').textContent = indices.join(',');
    }
    el('stream-end').textContent = 'yes';
  });

  ready();
}

setup();
