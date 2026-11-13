import type { RawData, WebSocket } from 'ws';
import type * as Socket from './socket.ts';
import type { ConnectionTransport } from './socket.ts';

/** Whether a message is the `__connected__` frame the engine sends first on every connection. */
export function isConnectedFrame(data: RawData, isBinary: boolean): boolean {
  return !isBinary && data.toString().startsWith('["__connected__"');
}

/**
 * The next message a ws client gets, with whether it came as a binary message. It skips
 * the `__connected__` frame, which the specs that use it do not test.
 */
export function nextRawMessage(socket: WebSocket): Promise<{ data: RawData; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    function onMessage(data: RawData, isBinary: boolean): void {
      if (isConnectedFrame(data, isBinary)) return;

      socket.off('message', onMessage);
      socket.off('error', reject);
      resolve({ data, isBinary });
    }

    socket.on('message', onMessage);
    socket.once('error', reject);
  });
}

/** The next message a ws client gets, parsed as JSON, after the `__connected__` frame. */
export async function nextJsonMessage<T>(socket: WebSocket): Promise<T> {
  const { data } = await nextRawMessage(socket);

  return JSON.parse(data.toString()) as T;
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
