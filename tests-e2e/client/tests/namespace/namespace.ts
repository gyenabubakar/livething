import { client, connect, namespaces, requestResponse, stream } from '@wskit/client';
import type { NamespaceClient } from '@wskit/tests-e2e-handlers/namespace';
import { button, el, mount, ready, wsUrl } from '../_shared.ts';

// Drives @wskit/client's namespace scoping against the real `namespace` handler,
// typed by the same contract the server implements
// (NamespaceClient = InferClient<handler>).
export function setup(): void {
  mount(`
    <button data-testid="connect">connect</button>
    <button data-testid="send-ns">send-ns</button>
    <button data-testid="broadcast-ns">broadcast-ns</button>
    <button data-testid="ns-info">ns-info</button>
    <button data-testid="ns-stream">ns-stream</button>
    <span data-testid="status"></span>
    <span data-testid="ns-message"></span>
    <span data-testid="top-level-message"></span>
    <span data-testid="ns-result"></span>
    <span data-testid="ns-stream-chunks"></span>
    <span data-testid="ns-stream-end"></span>
  `);

  const socket = client<NamespaceClient>()(
    connect(wsUrl('namespace')),
    namespaces(),
    requestResponse(),
    stream(),
  );

  const ns = socket.namespace('ns');

  socket.subscribe(() => {
    el('status').textContent = socket.getState();
  });

  ns.on('ns-message', (data) => {
    el('ns-message').textContent = data.text;
  });

  // A namespace-tagged frame must never reach a top-level handler. The contract
  // has no top-level incoming events, so reach past the typed surface to prove
  // the same event name stays silent at the top level.
  (socket as unknown as { on(event: string, handler: (data: unknown) => void): () => void }).on(
    'ns-message',
    () => {
      el('top-level-message').textContent = 'leaked';
    },
  );

  button('connect', () => socket.connect());

  button('send-ns', () => {
    ns.send('send-ns', { text: 'hello ns' });
  });

  button('broadcast-ns', () => {
    ns.send('broadcast-ns', { text: 'broadcast msg' });
  });

  button('ns-info', async () => {
    const res = await ns.request('get-ns-info', {});
    el('ns-result').textContent = res.namespace;
  });

  button('ns-stream', async () => {
    const handle = await ns.stream('start-ns-stream', { count: 3 });
    const chunks: number[] = [];
    for await (const chunk of handle) {
      chunks.push(chunk.index);
      el('ns-stream-chunks').textContent = chunks.join(',');
    }
    el('ns-stream-end').textContent = 'yes';
  });

  ready();
}

setup();
