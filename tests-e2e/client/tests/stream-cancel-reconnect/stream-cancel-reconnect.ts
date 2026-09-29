import { client, connect, reconnection, stream } from '@livething/client';
import type { StreamDurableClient } from '@livething/tests-e2e-handlers/stream-durable';
import { button, el, errorCode, mount, ready, wsUrl } from '../_shared.ts';

// Drives @livething/client against the real `stream-durable` server definition to prove a
// cancel() issued while the socket is reconnecting is not lost: the client holds
// __streamCancel__ until reopen, suppresses the durable stream's auto-reconnect, and
// the server deletes the durable row. A later continueStream() of that id then
// aborts with reason not-found — proof the row is gone.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="start-paginate">start-paginate</button>
    <button data-testid="server-drop">server-drop</button>
    <button data-testid="cancel">cancel</button>
    <button data-testid="continue-paginate">continue-paginate</button>
    <span data-testid="status"></span>
    <span data-testid="rows"></span>
    <span data-testid="ended"></span>
    <span data-testid="error-code"></span>
    <span data-testid="error-reason"></span>
    <span data-testid="continue-error-code"></span>
    <span data-testid="continue-error-reason"></span>
  `);

  const socket = client<StreamDurableClient>()(
    connect(wsUrl('stream-durable')),
    reconnection(),
    stream({ timeout: 2000 }),
  );

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  const rows: number[] = [];
  let handle: { cancel(): void } | null = null;

  async function drain(
    iterable: AsyncIterable<{ row: number }>,
    errId: 'error' | 'continue-error',
  ): Promise<void> {
    try {
      for await (const chunk of iterable) {
        rows.push(chunk.row);
        el('rows').textContent = rows.join(',');
      }

      if (errId === 'error') el('ended').textContent = 'yes';
    } catch (err) {
      el(`${errId}-code`).textContent = errorCode(err);
      el(`${errId}-reason`).textContent =
        (err as { detail?: { reason?: string } })?.detail?.reason ?? '';
    }
  }

  button('connect', () => socket.connect());

  button('start-paginate', async () => {
    const started = await socket.stream('paginate', {}, { streamId: 'pages-cancel' });
    handle = started;
    void drain(started, 'error');
  });

  button('server-drop', () => {
    socket.send('server-drop', {});
  });

  // Called while reconnecting — the cancel is held and flushed on reopen.
  button('cancel', () => {
    handle?.cancel();
  });

  // After the cancel deleted the durable row, continuing that id must abort not-found.
  button('continue-paginate', () => {
    const continued = socket.continueStream('paginate', 'pages-cancel');
    void drain(continued, 'continue-error');
  });

  ready();
}

setup();
