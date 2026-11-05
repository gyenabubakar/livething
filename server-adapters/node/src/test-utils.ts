import type { RawData, WebSocket } from 'ws';
import type * as Socket from './socket.ts';
import type { ConnectionTransport } from './socket.ts';

/** The next message a ws client gets, with whether it came as a binary message. */
export function nextRawMessage(socket: WebSocket): Promise<{ data: RawData; isBinary: boolean }> {
  return new Promise((resolve) => {
    socket.once('message', (data, isBinary) => resolve({ data, isBinary }));
  });
}

/** One connection a test watched: the transport its adapter built, and the binary messages the engine got. */
export interface CapturedBridge {
  transport: ConnectionTransport;
  binaryMessages: Uint8Array[];
}

export const capturedBridges: CapturedBridge[] = [];

/**
 * A `./socket.ts` whose bridge records each transport and each binary message. Return it from
 * `vi.mock` so a test can see what the engine got and send through the adapter's real transport.
 */
export function captureBridges(socket: typeof Socket): typeof Socket {
  return {
    ...socket,
    createConnectionBridge(options) {
      const handle = socket.createConnectionBridge(options);
      const bridge: CapturedBridge = { transport: options.transport, binaryMessages: [] };
      capturedBridges.push(bridge);

      return {
        ...handle,
        handleBinaryMessage(data) {
          bridge.binaryMessages.push(data);
          return handle.handleBinaryMessage(data);
        },
      };
    },
  };
}
