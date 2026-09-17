import { channels, client, connect, stream } from '@wskit/client';
import type { StreamDurableScopedClient } from '@wskit/tests-e2e-handlers/stream-durable-scoped';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's channel-scoped stream() / resumeStream() against the
// real `stream-durable-scoped` server definition, typed by the same contract the server
// implements (StreamDurableScopedClient = InferClient<definition>). The `rooms`
// channel exposes a resumable cursor stream (`paginate`) and a recorded stream
// (`history`); this proves both flow through the channel handle and that a
// resumable stream resumes from its cursor over the real wire.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="subscribe">subscribe</button>
    <button data-testid="start-paginate">start-paginate</button>
    <button data-testid="resume-paginate">resume-paginate</button>
    <button data-testid="start-history">start-history</button>
    <span data-testid="status"></span>
    <span data-testid="subscribed"></span>
    <span data-testid="rows"></span>
    <span data-testid="rows-ended"></span>
    <span data-testid="history"></span>
    <span data-testid="history-ended"></span>
    <span data-testid="error-code"></span>
  `);

  const socket = client<StreamDurableScopedClient>()(
    connect(wsUrl('stream-durable-scoped')),
    channels(),
    stream({ timeout: 2000 }),
  );

  const rooms = socket.channel('rooms');

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  const rows: number[] = [];
  function renderRows(): void {
    el('rows').textContent = rows.join(',');
  }

  async function drainRows(handle: AsyncIterable<{ row: number }>): Promise<void> {
    try {
      for await (const chunk of handle) {
        rows.push(chunk.row);
        renderRows();
      }

      el('rows-ended').textContent = 'yes';
    } catch (err) {
      el('error-code').textContent = errorCode(err);
    }
  }

  button('connect', () => socket.connect());

  button('subscribe', async () => {
    await rooms.subscribe();
    el('subscribed').textContent = 'true';
  });

  button('start-paginate', async () => {
    const handle = await rooms.stream('paginate', {}, { streamId: 'pages-1' });
    void drainRows(handle);
  });

  // After the resumable stream ends, its cursor is retained. A manual resume
  // from the saved cursor reattaches on the channel handle and ends cleanly.
  button('resume-paginate', () => {
    el('rows-ended').textContent = 'no';
    const handle = rooms.resumeStream('paginate', 'pages-1', { lastKnownSeq: rows.length });
    void drainRows(handle);
  });

  button('start-history', async () => {
    const idx: number[] = [];
    const handle = await rooms.stream('history', {});
    for await (const chunk of handle) {
      idx.push(chunk.idx);
      el('history').textContent = idx.join(',');
    }

    el('history-ended').textContent = 'yes';
  });

  ready();
}

setup();
