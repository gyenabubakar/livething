import { createSseHub } from '@livething/server/adapters';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionHandle, SseStream } from '@livething/server/adapters';
import { createCloudflareSseHandler } from './sse.ts';

interface OpenedStream {
  socket: SseStream['socket'];
  reader: ReadableStreamDefaultReader<Uint8Array>;
  handleClose: ReturnType<typeof vi.fn>;
}

/** An SSE handler of one object, with caps small enough for a test. */
function huddleObject(caps = { streamBytes: 1_000, objectBytes: 1_500 }) {
  let pending: Omit<OpenedStream, 'reader'> | null = null;
  const handle = createCloudflareSseHandler({
    hub: createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 }),
    originAllowed: () => true,
    authenticate: async () => ({}),
    attach(socket) {
      const handleClose = vi.fn(async () => {});
      pending = { socket, handleClose };
      return { handleClose } as unknown as ConnectionHandle;
    },
    caps,
  });

  return {
    async open(): Promise<OpenedStream> {
      const response = await handle(
        new Request('https://huddle.test/', { headers: { Accept: 'text/event-stream' } }),
      );
      return { ...pending!, reader: response.body!.getReader() };
    },
  };
}

/** A frame whose `data:` event is `size` bytes long. */
function frame(size: number) {
  return { kind: 'text', text: 'x'.repeat(size - 8) } as const;
}

describe('the unread-bytes caps of Cloudflare SSE', () => {
  it('drops a stream at once when its unread bytes would pass the stream cap', async () => {
    const huddle = huddleObject();
    const kofi = await huddle.open();

    kofi.socket.send(frame(600));
    expect(kofi.socket.bufferedAmount()).toBe(600);
    kofi.socket.send(frame(600));

    await expect(kofi.reader.read()).rejects.toThrow(/stopped reading/);
    expect(kofi.socket.bufferedAmount()).toBe(0);
    await vi.waitFor(() =>
      expect(kofi.handleClose).toHaveBeenCalledWith(
        1013,
        '[livething] the client reads too slowly',
      ),
    );
  });

  it('keeps a stream whose client reads, however much goes through it', async () => {
    const huddle = huddleObject();
    const kofi = await huddle.open();

    for (let i = 0; i < 10; i++) {
      kofi.socket.send(frame(600));
      await kofi.reader.read();
    }

    expect(kofi.handleClose).not.toHaveBeenCalled();
  });

  it('drops the stream with the most unread bytes when the object passes its cap', async () => {
    const huddle = huddleObject();
    const kofi = await huddle.open();
    const amara = await huddle.open();

    kofi.socket.send(frame(900));
    amara.socket.send(frame(500));
    amara.socket.send(frame(200));

    await expect(kofi.reader.read()).rejects.toThrow(/stopped reading/);
    await vi.waitFor(() => expect(kofi.handleClose).toHaveBeenCalledWith(1013, expect.any(String)));
    expect(amara.handleClose).not.toHaveBeenCalled();
    expect(amara.socket.bufferedAmount()).toBe(700);
  });

  it('stops counting a stream once it has ended', async () => {
    const huddle = huddleObject();
    const kofi = await huddle.open();
    const amara = await huddle.open();

    kofi.socket.send(frame(900));
    kofi.socket.close(4000, 'left the huddle');
    await kofi.reader.read();
    await kofi.reader.read();
    amara.socket.send(frame(900));

    expect(amara.handleClose).not.toHaveBeenCalled();
    expect(amara.socket.bufferedAmount()).toBe(900);
  });
});

describe('a client that drops its stream', () => {
  it('closes the connection with 1006 when the runtime reports the abort', async () => {
    const huddle = huddleObject();
    const kofi = await huddle.open();
    kofi.socket.send(frame(600));

    await kofi.reader.cancel();

    await vi.waitFor(() => expect(kofi.handleClose).toHaveBeenCalledWith(1006, 'stream ended'));
    expect(kofi.socket.send(frame(100))).toBe(false);
  });
});
