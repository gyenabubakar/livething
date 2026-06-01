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
  binaryType: 'arraybuffer' | 'blob' = 'blob';
  protocol = '';
  readyState = 0;
  sent: unknown[] = [];

  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
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
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.onmessage?.({ data });
  }

  /** Pretend a message arrived exactly as given (for binary like an ArrayBuffer). */
  emitRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Pretend the server dropped the connection. */
  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: false });
  }

  /** The frames this socket sent, decoded back from JSON. */
  sentFrames(): any[] {
    return this.sent.map((s) => (typeof s === 'string' ? JSON.parse(s) : s));
  }
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
