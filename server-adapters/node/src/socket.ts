import * as ws from 'ws';
import type {
  AuthDecision,
  ConnectionDescriptor,
  ConnectionHandle,
  Engine,
  TransportConnection,
  TransportFrame,
} from '@livething/server/adapters';
import type { WebSocket } from 'ws';

/** What a WebSocket `send()` takes for a frame: a string goes as text, bytes go as binary. */
export function frameData(frame: TransportFrame): string | Uint8Array<ArrayBuffer> {
  return frame.kind === 'text' ? frame.text : frame.bytes;
}

/** `ws` internals a pre-built frame is written through. `@types/ws` does not declare them. */
interface WsInternals {
  _sender?: { sendFrame?: (list: Buffer[]) => void };
  _extensions?: Record<string, unknown>;
  _socket?: TcpSocket;
}

interface TcpSocket {
  cork(): void;
  uncork(): void;
  readonly writableLength: number;
}

/**
 * The TCP sockets corked until the end of the current tick, each with the bytes it held before.
 * Holding a socket's writes until the end of the tick sends every frame written to it in the
 * tick with one system call instead of one each: a burst of broadcasts to many members was
 * mostly system calls before. The order of the frames does not change, and one `nextTick`
 * uncorks every socket.
 */
const corkedThisTick = new Map<TcpSocket, number>();

/**
 * A socket holding this many bytes written in the current tick sends them at once. Batching
 * gains nothing past this size, and held bytes count in `bufferedAmount`: replay catch-up and
 * `ctx.stream.drain()` would wait on bytes that only wait for the tick to end.
 */
const HOLD_BYTES = 64 * 1024;

function uncorkAll(): void {
  try {
    for (const tcp of corkedThisTick.keys()) tcp.uncork();
  } finally {
    corkedThisTick.clear();
  }
}

function corkForTick(tcp: TcpSocket): void {
  if (corkedThisTick.has(tcp)) return;

  if (corkedThisTick.size === 0) process.nextTick(uncorkAll);
  corkedThisTick.set(tcp, tcp.writableLength);
  tcp.cork();
}

/** Send what a socket holds now, before the tick ends. */
function release(tcp: TcpSocket): void {
  if (!corkedThisTick.delete(tcp)) return;

  tcp.uncork();
}

/** Terminate a `ws` socket after sending the frames it holds, which `terminate()` would drop. */
export function terminateWs(socket: Pick<WebSocket, 'terminate'>): void {
  const tcp = (socket as WsInternals)._socket;
  if (tcp) release(tcp);

  socket.terminate();
}

const { Sender } = ws as unknown as {
  Sender: { frame(data: Buffer, options: Record<string, boolean | number>): Buffer[] };
};

/** An unmasked, uncompressed, final text frame: what a server sends. */
const TEXT_FRAME = { fin: true, rsv1: false, opcode: 1, mask: false, readOnly: false };

/**
 * The whole WebSocket frame (header and UTF-8 bytes) of shared text frames, or `null` after the
 * first send. A broadcast hands every member the same frame object, so the frame is built on the
 * second send and written as it is to every later socket, the way Socket.IO broadcasts on `ws`.
 * A shared frame that reaches one socket never pays for it.
 */
const sharedTextFrames = new WeakMap<TransportFrame, Buffer[] | null>();

/**
 * The `ws` sender a pre-built frame can be written to, or `undefined`. `ws` queues a send only
 * while it compresses or reads a `Blob`, so a socket without compression (LiveThing sends no
 * `Blob`) writes in order. A compressed socket, or a `ws` without `sendFrame`, goes through `send()`.
 */
function frameSender(socket: object): { sendFrame: (list: Buffer[]) => void } | undefined {
  const internals = socket as WsInternals;
  if (internals._extensions?.['permessage-deflate'] !== undefined) return undefined;

  const sender = internals._sender;
  return typeof sender?.sendFrame === 'function'
    ? (sender as { sendFrame: (list: Buffer[]) => void })
    : undefined;
}

/** Send one frame on a `ws` socket: text as a text message, bytes as a binary message. */
export function sendToWs(socket: Pick<WebSocket, 'send'>, frame: TransportFrame): void {
  const tcp = (socket as WsInternals)._socket;
  if (!tcp) {
    writeFrame(socket, frame);
    return;
  }

  corkForTick(tcp);
  writeFrame(socket, frame);
  const heldBefore = corkedThisTick.get(tcp);
  if (heldBefore !== undefined && tcp.writableLength - heldBefore >= HOLD_BYTES) release(tcp);
}

function writeFrame(socket: Pick<WebSocket, 'send'>, frame: TransportFrame): void {
  if (frame.kind === 'bytes') {
    socket.send(frame.bytes);
    return;
  }

  if (!frame.shared) {
    socket.send(frame.text);
    return;
  }

  let wire = sharedTextFrames.get(frame);
  if (wire === undefined) {
    sharedTextFrames.set(frame, null);
    socket.send(frame.text);
    return;
  }

  if (wire === null) {
    wire = Sender.frame(Buffer.from(frame.text), TEXT_FRAME);
    sharedTextFrames.set(frame, wire);
  }

  const sender = frameSender(socket);
  if (sender) sender.sendFrame(wire);
  // An unmasked frame keeps the payload apart from the header, as its last buffer. Newer ws
  // returns only the header for an empty payload.
  else socket.send(wire.length > 1 ? wire.at(-1)! : frame.text, { binary: false });
}

/** The WebSocket `readyState` of an open socket. */
const WEB_SOCKET_OPEN = 1;

/**
 * Send one frame only while the socket is open. Node WebSocket libraries drop
 * or reject a send on a closing socket in different ways, so every transport
 * reports it the same way: as not delivered. A socket that does not expose
 * `readyState` is always sent to.
 */
export function sendWhenOpen(readyState: number | undefined, send: () => unknown): boolean {
  if (readyState !== undefined && readyState !== WEB_SOCKET_OPEN) return false;

  send();
  return true;
}

/**
 * Transport functions the engine needs for an accepted connection. `send()` returns `false`
 * when the frame was not sent, for example because the socket is closing.
 */
export type ConnectionTransport = TransportConnection;

/** Inputs required to connect an accepted WebSocket transport to the engine. */
export interface ConnectionBridgeOptions {
  engine: Pick<Engine, 'accept'>;
  token: unknown;
  transport: ConnectionTransport;
  decision: AuthDecision;
}

/** Creates the engine connection handle for an accepted transport. */
export function createConnectionBridge(options: ConnectionBridgeOptions): ConnectionHandle {
  const { engine, token, transport, decision } = options;
  const descriptor: ConnectionDescriptor = {
    send: (frame) => transport.send(frame),
    close: (code, reason) => transport.close(code, reason),
    ...(transport.terminate ? { terminate: () => transport.terminate?.() } : {}),
    bufferedAmount: () => transport.bufferedAmount(),
    backpressureSupported: transport.backpressureSupported,
    secret: transport.secret ?? null,
    maxPostBytes: transport.maxPostBytes ?? null,
    userId: decision.userId ?? '',
    meta: decision.meta ?? {},
    tags: decision.tags ?? [],
  };

  return engine.accept(token, descriptor);
}
