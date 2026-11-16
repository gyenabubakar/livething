import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { Socket } from 'node:net';
import { sendToWs, terminateWs, wsBufferedAmount } from './socket.ts';

function recorder() {
  const sent: { data: string | Uint8Array; binary: boolean | undefined }[] = [];
  const socket = {
    send(data: string | Uint8Array, options?: { binary?: boolean }) {
      sent.push({ data, binary: options?.binary });
    },
    close() {},
  } as unknown as Pick<WebSocket, 'send' | 'close'>;

  return { sent, socket };
}

describe('sendToWs', () => {
  it('sends a frame for one socket as a string', () => {
    const { sent, socket } = recorder();

    sendToWs(socket, { kind: 'text', text: '["echoed",{},null]', shared: false });

    expect(sent).toEqual([{ data: '["echoed",{},null]', binary: undefined }]);
  });

  it('sends a shared frame through send() on a socket it cannot hold frames for', () => {
    const frame = { kind: 'text', text: '["message",{"text":"hé"},null]', shared: true } as const;
    const first = recorder();
    const second = recorder();

    sendToWs(first.socket, frame);
    sendToWs(second.socket, frame);

    expect(first.sent).toEqual([{ data: frame.text, binary: undefined }]);
    expect(second.sent).toEqual([{ data: frame.text, binary: undefined }]);
  });

  describe('on real ws sockets', () => {
    const servers: WebSocketServer[] = [];
    const clients: WebSocket[] = [];

    afterEach(async () => {
      for (const client of clients.splice(0)) client.terminate();
      await Promise.all(
        servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
      );
    });

    /** Open `count` client sockets; resolve with the server side of each and what each receives. */
    async function connect(count: number, perMessageDeflate = false) {
      const server = new WebSocketServer({ port: 0, perMessageDeflate });
      servers.push(server);
      await new Promise((resolve) => server.once('listening', resolve));
      const { port } = server.address() as { port: number };

      const sockets: WebSocket[] = [];
      const received: string[][] = [];
      for (let i = 0; i < count; i++) {
        const accepted = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
        const client = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate });
        clients.push(client);
        const messages: string[] = [];
        received.push(messages);

        client.on('message', (data, isBinary) => {
          expect(isBinary).toBe(false);
          messages.push(data.toString());
        });
        await new Promise((resolve) => client.once('open', resolve));
        sockets.push(await accepted);
      }

      return { sockets, received };
    }

    /** Count each socket's `send()` calls: a pre-built frame skips `send()`. */
    function countSends(sockets: WebSocket[]): number[] {
      const counts = sockets.map(() => 0);
      sockets.forEach((socket, i) => {
        const send = socket.send.bind(socket) as (...args: unknown[]) => void;
        socket.send = ((...args: unknown[]) => {
          counts[i]! += 1;
          send(...args);
        }) as WebSocket['send'];
      });

      return counts;
    }

    async function until(check: () => boolean): Promise<void> {
      const deadline = Date.now() + 2_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the frames');

        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    it('delivers a shared frame of every header size as the same text to every socket', async () => {
      const { sockets, received } = await connect(3);
      // Lengths that need a 7-bit, a 16-bit and a 64-bit payload length.
      const texts = ['é', 'ü'.repeat(200), 'ß'.repeat(40_000)].map((text) =>
        JSON.stringify(['message', { text }, null]),
      );
      const sends = countSends(sockets);

      for (const text of texts) {
        const frame = { kind: 'text', text, shared: true } as const;
        for (const socket of sockets) sendToWs(socket, frame);
      }

      await until(() => received.every((messages) => messages.length === texts.length));
      for (const messages of received) expect(messages).toEqual(texts);
      // Every socket gets the built frame, never through send().
      expect(sends).toEqual([0, 0, 0]);
    });

    it('delivers text and binary frames of every header size, in order', async () => {
      const server = new WebSocketServer({ port: 0, perMessageDeflate: false });
      servers.push(server);
      await new Promise((resolve) => server.once('listening', resolve));
      const { port } = server.address() as { port: number };

      const accepted = new Promise<WebSocket>((resolve) => server.once('connection', resolve));
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      clients.push(client);

      const received: (string | number[])[] = [];
      client.on('message', (data: Buffer, isBinary) => {
        received.push(isBinary ? [data.length, data[0] ?? -1, data.at(-1) ?? -1] : data.toString());
      });
      await new Promise((resolve) => client.once('open', resolve));
      const socket = await accepted;

      // Payload lengths at each edge of the 7-bit, 16-bit and 64-bit lengths, empty included.
      const lengths = [0, 125, 126, 65_535, 65_536, 100_000];
      const expected: (string | number[])[] = [];
      for (const length of lengths) {
        const bytes = new Uint8Array(length).fill(7);
        if (length > 0) bytes[length - 1] = 9;
        const text = JSON.stringify(['row', { text: 'é'.repeat(Math.floor(length / 2)) }, null]);

        sendToWs(socket, { kind: 'bytes', bytes });
        sendToWs(socket, { kind: 'text', text, shared: false });
        expected.push(length === 0 ? [0, -1, -1] : [length, 7, 9], text);
      }

      await until(() => received.length === expected.length);
      expect(received).toEqual(expected);
    });

    it('sends the held frames before a close frame', async () => {
      const { sockets, received } = await connect(1);
      const closed = new Promise<number>((resolve) => clients[0]!.once('close', resolve));
      const texts = ['["a",{},null]', '["b",{},null]'];

      for (const text of texts) sendToWs(sockets[0]!, { kind: 'text', text, shared: false });
      sockets[0]!.close(1000, 'bye');

      expect(await closed).toBe(1000);
      expect(received[0]).toEqual(texts);
    });

    it('drops the held frames of a socket destroyed in the same turn', async () => {
      const { sockets } = await connect(1);
      const tcp = (sockets[0] as unknown as { _socket: Socket })._socket;
      const errors: Error[] = [];
      tcp.on('error', (error) => errors.push(error));

      sendToWs(sockets[0]!, { kind: 'text', text: '["a",{},null]', shared: false });
      tcp.destroy();
      const write = vi.spyOn(tcp, 'write');

      await new Promise((resolve) => setImmediate(resolve));
      expect(write).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    });

    it('writes big frames as header and payload, with no copy', async () => {
      const { sockets, received } = await connect(1);
      const tcp = (sockets[0] as unknown as { _socket: Socket })._socket;
      const write = vi.spyOn(tcp, 'write');
      const texts = ['x', 'y', 'z'].map((letter) =>
        JSON.stringify(['row', { text: letter.repeat(5000) }, null]),
      );

      for (const text of texts) sendToWs(sockets[0]!, { kind: 'text', text, shared: false });
      await new Promise((resolve) => setImmediate(resolve));
      // A header and a payload for each frame, sent together.
      expect(write).toHaveBeenCalledTimes(6);

      const big = 'b'.repeat(64 * 1024);
      sendToWs(sockets[0]!, { kind: 'text', text: big, shared: false });
      // A frame over the hold limit goes at once, without waiting for the turn to end.
      expect(write).toHaveBeenCalledTimes(8);
      expect((write.mock.calls[7]![0] as Buffer).byteLength).toBe(big.length);

      await until(() => received[0]!.length === texts.length + 1);
      expect(received[0]).toEqual([...texts, big]);
    });

    it('counts held frames in bufferedAmount until they are written', async () => {
      const { sockets } = await connect(1);
      const text = '["a",{},null]';

      sendToWs(sockets[0]!, { kind: 'text', text, shared: false });
      expect(wsBufferedAmount(sockets[0]!)).toBe(sockets[0]!.bufferedAmount + 2 + text.length);

      await new Promise((resolve) => setImmediate(resolve));
      expect(wsBufferedAmount(sockets[0]!)).toBe(sockets[0]!.bufferedAmount);
    });

    it('keeps the order of shared and single frames on one socket', async () => {
      const { sockets, received } = await connect(2);
      const shared = { kind: 'text', text: '["message",{"n":1},null]', shared: true } as const;

      for (const socket of sockets) {
        sendToWs(socket, { kind: 'text', text: '["before",{},null]', shared: false });
        sendToWs(socket, shared);
        sendToWs(socket, { kind: 'text', text: '["after",{},null]', shared: false });
      }

      await until(() => received.every((messages) => messages.length === 3));
      for (const messages of received) {
        expect(messages).toEqual(['["before",{},null]', shared.text, '["after",{},null]']);
      }
    });

    it('writes every frame sent to a socket in one turn with one system call', async () => {
      const { sockets, received } = await connect(1);
      const tcp = (sockets[0] as unknown as { _socket: Socket })._socket;
      const writes = { one: 0, many: 0 };
      const write = tcp._write.bind(tcp);
      const writev = tcp._writev!.bind(tcp);

      tcp._write = (...args) => {
        writes.one += 1;
        write(...args);
      };
      tcp._writev = (...args) => {
        writes.many += 1;
        writev(...args);
      };
      const texts = ['["a",{},null]', '["b",{},null]', '["c",{},null]', '["d",{},null]'];

      const [first, ...rest] = texts;
      sendToWs(sockets[0]!, { kind: 'text', text: first!, shared: false });
      // Code after an `await`, or the read of another socket, still writes into the same turn.
      await new Promise((resolve) => process.nextTick(resolve));
      for (const text of rest) sendToWs(sockets[0]!, { kind: 'text', text, shared: false });
      expect(writes).toEqual({ one: 0, many: 0 });
      await new Promise((resolve) => setImmediate(resolve));

      await until(() => received[0]!.length === texts.length);
      expect(received[0]).toEqual(texts);
      // Small frames go out as one buffer: one write, not a list of pieces.
      expect(writes).toEqual({ one: 1, many: 0 });

      // The next turn holds its frames again, and lets them go at its end.
      sendToWs(sockets[0]!, { kind: 'text', text: '["e",{},null]', shared: false });
      expect(writes).toEqual({ one: 1, many: 0 });
      await until(() => received[0]!.length === texts.length + 1);
      expect(writes).toEqual({ one: 2, many: 0 });
    });

    it('sends at once what a socket holds past 64 KiB, so bufferedAmount shows only real backlog', async () => {
      const { sockets, received } = await connect(2);
      const [held, plain] = sockets as [WebSocket, WebSocket];
      const text = JSON.stringify(['row', { text: 'x'.repeat(1000) }, null]);
      const highest = { held: 0, plain: 0 };

      // A replay catch-up sends rows in one loop and waits while bufferedAmount is 256 KiB or more.
      // The kernel buffer fills in the loop too, so the plain socket shows the real backlog.
      for (let i = 0; i < 1000; i++) {
        sendToWs(held, { kind: 'text', text, shared: false });
        plain.send(text);
        highest.held = Math.max(highest.held, wsBufferedAmount(held));
        highest.plain = Math.max(highest.plain, plain.bufferedAmount);
      }

      expect(highest.held).toBeLessThan(highest.plain + 64 * 1024 + 2 * text.length);
      await until(() => received.every((messages) => messages.length === 1000));
    });

    it('sends the frames a socket holds before terminating it', async () => {
      const { sockets, received } = await connect(1);
      const closed = new Promise((resolve) => clients[0]!.once('close', resolve));
      const texts = ['["a",{},null]', '["b",{},null]', '["c",{},null]'];

      for (const text of texts) sendToWs(sockets[0]!, { kind: 'text', text, shared: false });
      terminateWs(sockets[0]!);

      await closed;
      expect(received[0]).toEqual(texts);
    });

    it('sends a shared frame through send() on a compressed socket', async () => {
      const { sockets, received } = await connect(3, true);
      const frame = {
        kind: 'text',
        text: `["message",${JSON.stringify({ text: 'a'.repeat(2000) })},null]`,
        shared: true,
      } as const;

      const sends = countSends(sockets);

      for (const socket of sockets) sendToWs(socket, frame);

      await until(() => received.every((messages) => messages.length === 1));
      for (const messages of received) expect(messages).toEqual([frame.text]);
      expect(sends).toEqual([1, 1, 1]);
    });
  });

  it('sends a bytes frame as binary', () => {
    const { sent, socket } = recorder();
    const bytes = new Uint8Array([1, 2, 3]);

    sendToWs(socket, { kind: 'bytes', bytes });

    expect(sent).toEqual([{ data: bytes, binary: undefined }]);
  });
});
