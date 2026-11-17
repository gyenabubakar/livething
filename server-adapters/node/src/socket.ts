import { transportDescriptor } from '@livething/server/adapters';
import * as ws from 'ws';
import type {
  AuthDecision,
  ConnectionHandle,
  Engine,
  TransportConnection,
  TransportFrame,
} from '@livething/server/adapters';
import type { WebSocket } from 'ws';
import {
  gatesItsOwnWrites,
  giveOwnGate,
  LOST_WRITE_CLOSE,
  onWriteGateFailure,
} from './write-gate.ts';
import type { NodeWriteGate } from './write-gate.ts';

/** What a WebSocket `send()` takes for a frame: a string goes as text, bytes go as binary. */
export function frameData(frame: TransportFrame): string | Uint8Array<ArrayBuffer> {
  return frame.kind === 'text' ? frame.text : frame.bytes;
}

interface TcpSocket {
  cork(): void;
  uncork(): void;
  write(chunk: Uint8Array): boolean;
  readonly writableLength: number;
  readonly destroyed: boolean;
}

type SendFrame = (list: readonly (Uint8Array | string)[], callback?: () => void) => void;

interface WsSender {
  sendFrame: SendFrame;
  _socket: TcpSocket;
  /** The write gate of the endpoint that accepted the socket. LiveThing sets it. */
  livethingWriteGate?: NodeWriteGate;
}

/** `ws` internals the frames are written through. `@types/ws` does not declare them. */
interface WsInternals {
  _sender?: WsSender;
  _extensions?: Record<string, unknown>;
  _socket?: TcpSocket;
}

const { Sender } = ws as unknown as { Sender: { prototype: { sendFrame?: SendFrame } } };
const wsSendFrame = Sender.prototype.sendFrame;

/**
 * The frames sent to one socket in this turn and not written yet. A frame is either a whole
 * frame (`opcode` 0) or a payload that still needs its header.
 */
class HeldFrames {
  readonly gate: NodeWriteGate;
  readonly payloads: (Uint8Array | string)[] = [];
  readonly opcodes: number[] = [];
  readonly lengths: number[] = [];
  bytes = 0;

  constructor(gate: NodeWriteGate) {
    this.gate = gate;
  }
}

/**
 * The sockets holding frames until the end of this turn. A member of a busy channel gets many
 * small frames in one turn, and each one costs the system call a piece of its own. Held, they
 * are written into one buffer and go out as one write. `setImmediate` runs once the turn has
 * read its I/O, so the broadcasts of every message read together go out together, the way the
 * event streams of `http()` do, and a frame waits for no new I/O.
 */
const heldThisTurn = new Map<WsSender, HeldFrames>();

/** The socket of each sender frames are held for, to close it when its held frames are dropped. */
const socketOfSender = new WeakMap<WsSender, Pick<WebSocket, 'close'>>();

function closeLostWrite(sender: WsSender): void {
  socketOfSender.get(sender)?.close(LOST_WRITE_CLOSE.code, LOST_WRITE_CLOSE.reason);
}

onWriteGateFailure((gate) => {
  for (const [sender, held] of heldThisTurn) {
    if (held.gate !== gate) continue;

    heldThisTurn.delete(sender);
    closeLostWrite(sender);
  }
});

/**
 * A socket holding this many bytes sends them at once. Holding gains nothing past this size,
 * and held bytes count in `bufferedAmount`: replay catch-up and `ctx.stream.drain()` would wait
 * on bytes that only wait for the turn to end.
 */
const HOLD_BYTES = 64 * 1024;

/**
 * Held frames smaller than this on average are copied into one buffer, which costs less than a
 * piece for each. Bigger ones go as corked writes, with no copy.
 */
const COPY_BYTES = 1024;

const OPCODE_FRAMED = 0;
const OPCODE_TEXT = 1;
const OPCODE_BINARY = 2;

function headerSize(length: number): number {
  if (length < 126) return 2;

  return length < 65_536 ? 4 : 10;
}

/** Writes frames one after another into a buffer that has room for them. */
class FrameWriter {
  readonly target: Buffer;
  at = 0;

  constructor(target: Buffer) {
    this.target = target;
  }

  /** The header of a final, unmasked frame: what a server sends. */
  header(opcode: number, length: number): void {
    const { target, at } = this;
    target[at] = 0x80 | opcode;
    if (length < 126) {
      target[at + 1] = length;
      this.at += 2;
    } else if (length < 65_536) {
      target[at + 1] = 126;
      target.writeUInt16BE(length, at + 2);
      this.at += 4;
    } else {
      target[at + 1] = 127;
      target.writeUInt32BE(Math.floor(length / 2 ** 32), at + 2);
      target.writeUInt32BE(length >>> 0, at + 6);
      this.at += 10;
    }
  }

  payload(payload: Uint8Array | string): void {
    if (typeof payload === 'string') {
      this.at += this.target.write(payload, this.at);
      return;
    }

    this.target.set(payload, this.at);
    this.at += payload.byteLength;
  }
}

function payloadLength(payload: Uint8Array | string): number {
  return typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength;
}

/** One frame as a buffer of its own: its header and its payload. */
function frameBuffer(opcode: number, payload: Uint8Array | string): Buffer {
  const length = payloadLength(payload);
  const writer = new FrameWriter(Buffer.allocUnsafe(headerSize(length) + length));
  writer.header(opcode, length);
  writer.payload(payload);

  return writer.target;
}

function flushAll(): void {
  try {
    for (const [sender, held] of heldThisTurn) flush(sender, held);
  } finally {
    // A flush that threw must not leave the others held with no flush to come.
    if (heldThisTurn.size > 0) setImmediate(flushAll);
  }
}

function flush(sender: WsSender, held: HeldFrames): void {
  // On a failed commit, the failure drop has already dropped this socket's frames and closed it.
  if (!held.gate.commitBeforeWrite()) return;

  heldThisTurn.delete(sender);
  const tcp = sender._socket;
  if (tcp.destroyed) return;

  const { payloads, opcodes, lengths, bytes } = held;
  const count = payloads.length;
  if (bytes < count * COPY_BYTES) {
    const writer = new FrameWriter(Buffer.allocUnsafe(bytes));
    for (let index = 0; index < count; index++) {
      const opcode = opcodes[index]!;
      if (opcode !== OPCODE_FRAMED) writer.header(opcode, lengths[index]!);
      writer.payload(payloads[index]!);
    }

    tcp.write(writer.target);
    return;
  }

  tcp.cork();
  for (let index = 0; index < count; index++) {
    writeApart(tcp, opcodes[index]!, payloads[index]!);
  }

  tcp.uncork();
}

/** Write a frame's header and payload as two pieces, so a big payload is not copied. */
function writeApart(tcp: TcpSocket, opcode: number, payload: Uint8Array | string): void {
  if (opcode === OPCODE_FRAMED) {
    tcp.write(payload as Uint8Array);
    return;
  }

  const length = payloadLength(payload);
  const header = new FrameWriter(Buffer.allocUnsafe(headerSize(length)));
  header.header(opcode, length);
  tcp.write(header.target);
  tcp.write(typeof payload === 'string' ? Buffer.from(payload) : payload);
}

/**
 * The `sendFrame` of a sender that holds frames. `ws` writes its own frames through it (a
 * close, a ping, a pong), so the held frames go first and the order does not change.
 */
function sendAfterHeld(
  this: WsSender,
  list: readonly (Uint8Array | string)[],
  callback?: () => void,
): void {
  const held = heldThisTurn.get(this);
  if (held) flush(this, held);

  wsSendFrame!.call(this, list, callback);
}

function hold(sender: WsSender, opcode: number, payload: Uint8Array | string): void {
  const gate = sender.livethingWriteGate!;
  if (gate.failed) {
    closeLostWrite(sender);
    return;
  }

  const length = payloadLength(payload);
  let held = heldThisTurn.get(sender);
  if (!held) {
    // A frame this big would be sent at once anyway: it skips the hold.
    if (length >= HOLD_BYTES) {
      const tcp = sender._socket;
      if (tcp.destroyed) return;

      if (!gate.commitBeforeWrite()) {
        closeLostWrite(sender);
        return;
      }

      tcp.cork();
      writeApart(tcp, opcode, payload);
      tcp.uncork();
      return;
    }

    if (heldThisTurn.size === 0) setImmediate(flushAll);
    held = new HeldFrames(gate);
    heldThisTurn.set(sender, held);
  }

  held.payloads.push(payload);
  held.opcodes.push(opcode);
  held.lengths.push(length);
  held.bytes += opcode === OPCODE_FRAMED ? length : headerSize(length) + length;
  if (held.bytes >= HOLD_BYTES) flush(sender, held);
}

/**
 * The `ws` sender frames can be held for, or `undefined`. `ws` queues a send only while it
 * compresses or reads a `Blob`, so a socket without compression (LiveThing sends no `Blob`)
 * writes in order. A compressed socket, or a `ws` without `sendFrame`, goes through `send()`.
 */
function holdingSender(
  socket: Pick<WebSocket, 'close'>,
  gate: NodeWriteGate,
): WsSender | undefined {
  const internals = socket as WsInternals;
  if (internals._extensions?.['permessage-deflate'] !== undefined) return undefined;

  const sender = internals._sender;
  if (!sender?._socket || typeof wsSendFrame !== 'function') return undefined;

  if (sender.sendFrame !== sendAfterHeld) {
    sender.sendFrame = sendAfterHeld;
    sender.livethingWriteGate = gate;
    socketOfSender.set(sender, socket);
  }

  return sender;
}

/**
 * The whole WebSocket frame of a shared text frame. A broadcast hands every member the same
 * frame object, so its header and UTF-8 bytes are made once and copied to every member.
 */
const sharedTextFrames = new WeakMap<TransportFrame, Buffer>();

/**
 * Send one frame on a `ws` socket of the endpoint `gate` belongs to: text as a text message,
 * bytes as a binary message.
 */
export function sendToWs(
  gate: NodeWriteGate,
  socket: Pick<WebSocket, 'send' | 'close'>,
  frame: TransportFrame,
): void {
  const sender = holdingSender(socket, gate);
  if (!sender) {
    sendNow(gate, socket, frame);
    return;
  }

  if (frame.kind === 'bytes') {
    hold(sender, OPCODE_BINARY, frame.bytes);
    return;
  }

  if (!frame.shared) {
    hold(sender, OPCODE_TEXT, frame.text);
    return;
  }

  let wire = sharedTextFrames.get(frame);
  if (!wire) {
    wire = frameBuffer(OPCODE_TEXT, frame.text);
    sharedTextFrames.set(frame, wire);
  }

  hold(sender, OPCODE_FRAMED, wire);
}

/**
 * Send one frame at once, on a socket that does not hold frames: a compressed one, or a
 * framework's. A failed commit closes the socket instead, as it does the holding ones.
 */
function sendNow(
  gate: NodeWriteGate,
  socket: Pick<WebSocket, 'send' | 'close'>,
  frame: TransportFrame,
): void {
  if (gate.commitBeforeWrite()) socket.send(frameData(frame));
  else socket.close(LOST_WRITE_CLOSE.code, LOST_WRITE_CLOSE.reason);
}

/** The bytes a `ws` socket has not sent yet, held frames included. */
export function wsBufferedAmount(socket: Pick<WebSocket, 'bufferedAmount'>): number {
  const sender = (socket as WsInternals)._sender;
  const held = sender ? heldThisTurn.get(sender) : undefined;
  return socket.bufferedAmount + (held?.bytes ?? 0);
}

/** Terminate a `ws` socket after sending the frames it holds, which `terminate()` would drop. */
export function terminateWs(socket: Pick<WebSocket, 'terminate'>): void {
  const sender = (socket as WsInternals)._sender;
  const held = sender ? heldThisTurn.get(sender) : undefined;
  if (sender && held) flush(sender, held);

  socket.terminate();
}

/** The transport of a `ws` socket. It holds its frames and gates its own writes. */
export function webSocketTransport(socket: WebSocket): ConnectionTransport {
  let gate: NodeWriteGate | undefined;
  return gatesItsOwnWrites(
    {
      send: (frame) => sendWhenOpen(socket.readyState, () => sendToWs(gate!, socket, frame)),
      close: (code, reason) => socket.close(code, reason),
      terminate: () => terminateWs(socket),
      bufferedAmount: () => wsBufferedAmount(socket),
      backpressureSupported: true,
    },
    (endpointGate) => {
      gate = endpointGate;
    },
  );
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
  /** The write gate of the endpoint that accepts the connection. */
  writeGate: NodeWriteGate;
  token: unknown;
  transport: ConnectionTransport;
  decision: AuthDecision;
}

/**
 * Creates the engine connection handle for an accepted transport. A framework's or custom
 * transport's `send` is app code that can write the frame at once, so it runs after the gate.
 */
export function createConnectionBridge(options: ConnectionBridgeOptions): ConnectionHandle {
  const { engine, token, transport, decision, writeGate } = options;
  const descriptor = transportDescriptor(transport, decision);
  if (giveOwnGate(transport, writeGate)) return engine.accept(token, descriptor);

  const send = descriptor.send.bind(descriptor);
  descriptor.send = (frame) => {
    if (writeGate.commitBeforeWrite()) return send(frame);

    descriptor.close(LOST_WRITE_CLOSE.code, LOST_WRITE_CLOSE.reason);
    return false;
  };

  return engine.accept(token, descriptor);
}
