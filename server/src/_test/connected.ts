import type { TransportFrame } from '~/_adapters/types.ts';

/**
 * Whether a sent frame is the `__connected__` frame the engine sends first on every
 * connection. Specs about other frames skip it in their fake descriptor's `send`.
 */
export function isConnectedFrame(frame: TransportFrame | string): boolean {
  if (typeof frame === 'string') return frame.startsWith('["__connected__"');

  return frame.kind === 'text' && frame.text.startsWith('["__connected__"');
}

/** The payload of a `__connected__` frame, read from its text. */
export function connectedPayload(frame: TransportFrame | string): ConnectedPayload {
  const text = typeof frame === 'string' ? frame : (frame as { text: string }).text;

  return JSON.parse(text)[1] as ConnectedPayload;
}

export interface ConnectedPayload {
  pingIntervalMs: number | null;
  idleTimeoutMs: number | null;
  maxResumeTokens: number;
  connectionId: string;
  features: string[];
  resume: { token: string; seq: number | null } | null;
  secret: string | null;
  maxPostBytes: number | null;
}
