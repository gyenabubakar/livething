import { normalizeCloseReason } from '@wskit/server/adapters';
import type { WebSocket } from 'ws';

/** Closes a `ws` socket with a reason that fits the WebSocket control-frame limit. */
export function closeWebSocket(socket: WebSocket, code?: number, reason?: string): void {
  socket.close(code, normalizeCloseReason(reason));
}
