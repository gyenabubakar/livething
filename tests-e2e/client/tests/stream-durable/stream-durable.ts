import { client, connect, reconnection, stream } from '@livething/client';
import type { StreamDurableClient } from '@livething/tests-e2e-handlers/stream-durable';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @livething/client's stream() + continueStream() against the real
// `stream-durable` server definition. Proves durable streams auto-reconnect across an
// unexpected drop (close 4900) and that manual `continueStream` of an unknown id aborts
// with reason not-found.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="start-paginate">start-paginate</button>
    <button data-testid="drop-socket">drop-socket</button>
    <button data-testid="continue-paginate">continue-paginate</button>
    <button data-testid="continue-unknown">continue-unknown</button>
    <span data-testid="status"></span>
    <span data-testid="rows"></span>
    <span data-testid="row-count"></span>
    <span data-testid="ended"></span>
    <span data-testid="error-code"></span>
    <span data-testid="error-reason"></span>
  `);

  const lazy = new URLSearchParams(location.search).get('lazy') === '1';
  const socket = client<StreamDurableClient>()(
    // The server must outlive the drop: a recorded stream resumes only while its
    // generator is still running.
    connect(wsUrl('stream-durable', { holdRoom: true }), { lazy }),
    reconnection(),
    // Chunks come every 400 ms. A tighter per-chunk timeout fails the stream
    // on a slow machine before it ends.
    stream({ timeout: 5000 }),
  );

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  const rows: number[] = [];
  function render(): void {
    el('rows').textContent = rows.join(',');
    el('row-count').textContent = String(rows.length);
  }

  async function drain(handle: AsyncIterable<{ row: number }>): Promise<void> {
    try {
      for await (const chunk of handle) {
        rows.push(chunk.row);
        render();
      }

      el('ended').textContent = 'yes';
    } catch (err) {
      el('error-code').textContent = errorCode(err);
      el('error-reason').textContent =
        (err as { detail?: { reason?: string } })?.detail?.reason ?? '';
    }
  }

  button('connect', () => socket.connect());

  button('start-paginate', async () => {
    const handle = await socket.stream('paginate', {}, { streamId: 'pages-1' });
    void drain(handle);
  });

  button('drop-socket', () => {
    socket.send('server-drop', {});
  });

  button('continue-paginate', () => {
    // Clear the first run's result, so the spec waits for the reconnect to end.
    el('ended').textContent = '';
    const handle = socket.continueStream('paginate', 'pages-1', {
      lastKnownSeq: rows.length,
    });
    void drain(handle);
  });

  button('continue-unknown', () => {
    const handle = socket.continueStream('paginate', 'does-not-exist');
    void drain(handle);
  });

  ready();
}

setup();
