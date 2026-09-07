import { client, connect, reconnection, stream } from '@wskit/client';
import type { StreamDurableClient } from '@wskit/tests-e2e-handlers/stream-durable';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's stream() + resumeStream() against the real
// `stream-durable` handler. Proves durable streams auto-resume across an
// unexpected drop (close 4900) and that manual resume of an unknown id aborts
// with reason not-found.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="start-paginate">start-paginate</button>
    <button data-testid="drop-socket">drop-socket</button>
    <button data-testid="resume-paginate">resume-paginate</button>
    <button data-testid="resume-unknown">resume-unknown</button>
    <span data-testid="status"></span>
    <span data-testid="rows"></span>
    <span data-testid="row-count"></span>
    <span data-testid="ended"></span>
    <span data-testid="error-code"></span>
    <span data-testid="error-reason"></span>
  `);

  const lazy = new URLSearchParams(location.search).get('lazy') === '1';
  const socket = client<StreamDurableClient>()(
    connect(wsUrl('stream-durable'), { lazy }),
    reconnection(),
    stream({ timeout: 1000 }),
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

  button('resume-paginate', () => {
    const handle = socket.resumeStream('paginate', 'pages-1', {
      lastKnownSeq: rows.length,
    });
    void drain(handle);
  });

  button('resume-unknown', () => {
    const handle = socket.resumeStream('paginate', 'does-not-exist');
    void drain(handle);
  });

  ready();
}

setup();
