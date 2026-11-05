type EvParameter = { code: number; reason: string; wasClean: boolean };
type EvParameter2 = { data: unknown };
/* oxlint-disable @typescript-eslint/no-explicit-any -- test harness */

/**
 * A fake WebSocket you control by hand for tests. Install it as the global
 * `WebSocket`, then drive opens, messages, and closes yourself — no real network.
 */
export class MockWebSocket {
  static instances: MockWebSocket[] = [];
  /** The most recently created fake socket. */
  static last(): MockWebSocket {
    const ws = MockWebSocket.instances.at(-1);
    if (!ws) throw new Error('no MockWebSocket instance created yet');

    return ws;
  }
  static reset(): void {
    MockWebSocket.instances = [];
  }

  readonly url: string;
  readonly protocols?: string | string[];
  protocol = '';
  readyState = 0;
  /** Like the browser: `'blob'` until the client asks for `'arraybuffer'`. */
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  /** Set it by hand to test `socket.drain()`. */
  bufferedAmount = 0;
  sent: unknown[] = [];
  closeCall?: { code: number; reason: string };

  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: EvParameter) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: EvParameter2) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (code !== 1000 && (!Number.isInteger(code) || code < 3000 || code > 4999)) {
      throw new DOMException('Invalid close code', 'InvalidAccessError');
    }

    if (new TextEncoder().encode(reason).byteLength > 123) {
      throw new DOMException('Close reason is too long', 'SyntaxError');
    }

    this.closeCall = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: true });
  }

  /** Pretend the server accepted the connection. */
  open(protocol = ''): void {
    this.readyState = 1;
    this.protocol = protocol;
    this.onopen?.({});
  }

  /** Pretend a message arrived. Pass an object (auto-JSON) or a raw string. */
  emit(frame: unknown): void {
    let data: string;
    if (typeof frame === 'string') {
      data = frame;
    } else if (isMessage(frame)) {
      data = JSON.stringify([frame.event, frame.payload, frame.metadata]);
    } else {
      data = JSON.stringify(frame);
    }

    this.onmessage?.({ data });
  }

  /** Pretend a message arrived exactly as given (e.g. a raw string or ArrayBuffer). */
  emitRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Pretend the server dropped the connection. */
  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: false });
  }

  /**
   * The JSON frames this socket sent, decoded back from JSON. Raw control
   * frames like the bare text `"ping"`/`"pong"` aren't JSON — they're skipped
   * here; assert those against `sent` directly.
   */
  sentFrames(): any[] {
    return this.sent
      .map((s) => {
        if (typeof s !== 'string') return s;

        try {
          const frame = JSON.parse(s);
          return isWireFrame(frame)
            ? { event: frame[0], payload: frame[1], metadata: frame[2] }
            : frame;
        } catch {
          return undefined;
        }
      })
      .filter((f) => f !== undefined);
  }
}

function isMessage(value: unknown): value is {
  event: string;
  payload: unknown;
  metadata?: unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { event?: unknown }).event === 'string' &&
    'payload' in value &&
    true
  );
}

function isWireFrame(value: unknown): value is [string, unknown, unknown] {
  return Array.isArray(value) && value.length === 3 && typeof value[0] === 'string';
}

/** Swap in the fake WebSocket and return a function that puts the real one back. */
export function installMockWebSocket(): () => void {
  const original = (globalThis as any).WebSocket;
  MockWebSocket.reset();
  (globalThis as any).WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return () => {
    (globalThis as any).WebSocket = original;
  };
}
