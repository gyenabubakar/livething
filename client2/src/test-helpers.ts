/* oxlint-disable @typescript-eslint/no-explicit-any -- test harness */
/**
 * A controllable mock `WebSocket` for runtime tests. Install it as the global
 * `WebSocket`, drive opens/messages/closes by hand. No network, no MSW.
 */
export class MockWebSocket {
  static instances: MockWebSocket[] = [];
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

  // ── test drivers ──
  /** Simulate the server accepting the connection. */
  open(protocol = ''): void {
    this.readyState = 1;
    this.protocol = protocol;
    this.onopen?.({});
  }

  /** Simulate an inbound frame. Pass an object (auto-JSON) or a raw string. */
  emit(frame: unknown): void {
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
    this.onmessage?.({ data });
  }

  /** Simulate the server dropping the connection. */
  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: false });
  }

  /** The decoded JSON frames this socket sent. */
  sentFrames(): any[] {
    return this.sent.map((s) => (typeof s === 'string' ? JSON.parse(s) : s));
  }
}

/** Install the mock as the global WebSocket and return a restore function. */
export function installMockWebSocket(): () => void {
  const original = (globalThis as any).WebSocket;
  MockWebSocket.reset();
  (globalThis as any).WebSocket = MockWebSocket as unknown as typeof WebSocket;
  return () => {
    (globalThis as any).WebSocket = original;
  };
}
