import { normalizeCloseReason } from '@livething/server/adapters';

/** The common close surface shared by Node WebSocket transports. */
export interface ClosableWebSocket {
  close(code?: number, reason?: string): void;
}

/** Closes a WebSocket with a reason that fits the control-frame limit. */
export function closeWebSocket(socket: ClosableWebSocket, code?: number, reason?: string): void {
  socket.close(code, normalizeCloseReason(reason));
}
