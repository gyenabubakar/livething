import { withScheme } from './transport.ts';
import type { Transport, TransportFactory, TransportOpenOptions } from './transport.ts';

const OPEN = 1;

/** The WebSocket transport, and the default one. */
export function websocket(): TransportFactory {
  return { name: 'websocket', open: openWebSocket };
}

function openWebSocket(options: TransportOpenOptions): Transport {
  const { events } = options;
  const ws = new WebSocket(withScheme(options.url, 'wss', 'ws'), options.protocols);
  // A Blob can only be read with `await`, and a later message could be handled first.
  if (options.binary) ws.binaryType = 'arraybuffer';

  ws.onopen = () => events.open();
  ws.onclose = (event) => events.close(event.code, event.reason, event.wasClean);
  ws.onerror = (event) => events.error(event);
  ws.onmessage = (event) => events.message(event.data);

  return {
    name: 'websocket',
    get protocol() {
      return ws.protocol;
    },
    webSocket: ws,
    reportsStable: false,
    isOpen: () => ws.readyState === OPEN,
    send: (data) => ws.send(data),
    sendControl: (frame) => ws.send(frame),
    bufferedAmount: () => ws.bufferedAmount,
    close: (code, reason) => ws.close(code, reason),
    dispose(code, reason) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close(code, reason);
    },
  };
}
