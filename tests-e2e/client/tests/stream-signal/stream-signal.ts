import { client, connect, stream } from '@wskit/client';
import type { StreamSignalClient } from '@wskit/tests-e2e-handlers/stream-signal';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's stream().cancel() against the real `stream-signal`
// server definition, typed by the same contract the server implements (StreamSignalClient
// = InferClient<definition>). The generator yields one chunk then parks on a 60s
// timer wired to ctx.stream.signal; a client cancel must fire the signal and
// interrupt the parked work, proven by the `signal-fired` event.
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="start-slow">start-slow</button>
    <button data-testid="cancel">cancel</button>
    <span data-testid="status"></span>
    <span data-testid="stream-id"></span>
    <span data-testid="chunk-indices"></span>
    <span data-testid="signal-fired"></span>
    <span data-testid="signal-aborted"></span>
    <span data-testid="signal-reason"></span>
    <span data-testid="signal-ran-to-completion"></span>
  `);

  const socket = client<StreamSignalClient>()(connect(wsUrl('stream-signal')), stream());

  type Handle = Awaited<ReturnType<typeof socket.stream<'slow-signal'>>>;
  let handle: Handle | null = null;

  socket.state.subscribe(() => {
    el('status').textContent = socket.state.get();
  });

  // The handler's abort path emits this once the signal fires.
  socket.on('signal-fired', (data) => {
    el('signal-fired').textContent = 'yes';
    el('signal-aborted').textContent = data.aborted ? 'yes' : 'no';
    el('signal-reason').textContent = data.reason;
    el('signal-ran-to-completion').textContent = data.ranToCompletion ? 'yes' : 'no';
  });

  button('connect', () => socket.connect());

  button('start-slow', async () => {
    const started = await socket.stream('slow-signal', {});
    handle = started;
    el('stream-id').textContent = started.streamId;
    void (async () => {
      const indices: number[] = [];
      for await (const chunk of started) {
        indices.push(chunk.index);
        el('chunk-indices').textContent = indices.join(',');
      }
    })();
  });

  button('cancel', () => {
    handle?.cancel();
  });

  ready();
}

setup();
