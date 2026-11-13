import { Block, encodeMessage, LiveThingConfigError } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { plugin } from '~/plugins/plugins.ts';
import { binary } from '~/primitives/binary/index.ts';
import { buffering } from '~/primitives/buffering/index.ts';
import { channels } from '~/primitives/channels/index.ts';
import { clientRequests } from '~/primitives/client-requests/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { intercept } from '~/primitives/intercept.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { replay } from '~/primitives/replay.ts';
import { serverRequests } from '~/primitives/server-requests/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import {
  decodeSentFrame as decodeSent,
  binaryFrame as frame,
  installMockWebSocket,
  MockWebSocket,
} from '~/test-helpers.ts';
import { injectBinary, injectChannel, injectChannelBinary } from '~/testing.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@livething/core';
import type { Primitive } from '~/primitives/types.ts';

interface C {
  incoming: { 'avatar-saved': { userId: string }; 'avatar-preview': { jsonTwin: true } };
  binary: {
    incoming: { 'avatar-preview': null; 'avatar-cropped': { width: number } };
    outgoing: { 'upload-avatar': { fileType: string } };
  };
  clientRequests: { 'get-thumbnail': { payload: { attachmentId: string }; response: unknown } };
  streams: { 'download-attachment': { payload: { attachmentId: string }; chunk: unknown } };
  channels: {
    rooms: {
      addressing: 'dynamic';
      incoming: { 'screen-frame': unknown };
      binary: {
        incoming: { 'screen-frame': { from: string } };
        outgoing: { 'share-screen-frame': null };
      };
    };
    lobby: {
      binary: { incoming: { 'screen-frame': { from: string } } };
    };
  };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function typedAsEverything() {
  return client<C>()(connect('wss://test'), binary(), channels(), clientRequests(), stream());
}

/**
 * An open socket with the given primitives. It is typed as if every primitive were
 * there, because a generic wrapper loses the primitives' types; each test passes the
 * ones it uses, and always binary().
 */
function connected(...extras: Primitive[]) {
  const socket = client<C>()(
    connect('wss://test') as never,
    ...(extras as []),
  ) as unknown as ReturnType<typeof typedAsEverything>;
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

const picture = new Uint8Array([137, 80, 78, 71]);

describe('binary() setup', () => {
  it('sets binaryType to arraybuffer on every socket it opens', () => {
    const { ws } = connected(binary());
    expect(ws.binaryType).toBe('arraybuffer');
  });

  it('leaves binaryType at the default without binary()', () => {
    const socket = client()(connect('wss://test'));
    socket.connect();
    expect(MockWebSocket.last().binaryType).toBe('blob');
  });

  it('throws a LiveThingConfigError at client() time when TextDecoder is missing', () => {
    vi.stubGlobal('TextDecoder', undefined);
    expect(() => client<C>()(connect('wss://test'), binary())).toThrow(LiveThingConfigError);
    expect(() => client<C>()(connect('wss://test'), binary())).toThrow(
      'binary() needs TextDecoder',
    );
  });

  it('refuses a TextDecoder that ignores fatal: true', () => {
    class LooseDecoder {
      decode(): string {
        return '�';
      }
    }

    vi.stubGlobal('TextDecoder', LooseDecoder);
    expect(() => client<C>()(connect('wss://test'), binary())).toThrow(
      /does not honour fatal: true.*polyfill that supports fatal: true/,
    );
    expect(() => client<C>()(connect('wss://test'), binary())).not.toThrow(/does not have/);
  });

  it('names a missing TextDecoder apart from one that is not strict', () => {
    vi.stubGlobal('TextDecoder', undefined);
    expect(() => client<C>()(connect('wss://test'), binary())).toThrow(
      /does not have.*TextDecoder polyfill that supports fatal: true/,
    );
  });

  it('refuses a TextDecoder whose constructor rejects fatal: true', () => {
    class NoFatalDecoder {
      constructor(_label?: string, options?: { fatal?: boolean }) {
        if (options?.fatal) throw new RangeError('fatal is not supported');
      }
      decode(): string {
        return '';
      }
    }

    vi.stubGlobal('TextDecoder', NoFatalDecoder);
    expect(() => client<C>()(connect('wss://test'), binary())).toThrow(
      /does not honour fatal: true/,
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity])('rejects maxFrameBytes %s', (value) => {
    expect(() => binary({ maxFrameBytes: value })).toThrow(LiveThingConfigError);
  });
});

describe('a binary frame on a client with binary()', () => {
  it('routes a frame with the magic to its listener with the info and the bytes', () => {
    const { socket, ws } = connected(binary());
    const listener = vi.fn();
    socket.binary.on('avatar-cropped', listener);

    ws.emitRaw(frame('avatar-cropped', { width: 64 }, null, picture));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toEqual({ width: 64 });
    expect([...(listener.mock.calls[0]![1] as Uint8Array)]).toEqual([...picture]);
  });

  it('gives the bytes as a view of the whole frame', () => {
    const { socket, ws } = connected(binary());
    let got: Uint8Array | undefined;
    socket.binary.on('avatar-preview', (_info, bytes) => {
      got = bytes;
    });

    const data = frame('avatar-preview', null, null, picture);
    ws.emitRaw(data);

    expect(Object.getPrototypeOf(got)).toBe(Uint8Array.prototype);
    expect(got!.buffer).toBe(data);
    expect(got!.byteOffset).toBeGreaterThan(0);
    expect(got!.byteLength).toBe(picture.byteLength);
  });

  it('gives an empty Uint8Array when the frame has no bytes', () => {
    const { socket, ws } = connected(binary());
    const listener = vi.fn();
    socket.binary.on('avatar-preview', listener);

    ws.emitRaw(frame('avatar-preview', null, null));

    expect(listener).toHaveBeenCalledWith(null, new Uint8Array(0));
  });

  it.each([
    ['a wrong version', () => withByte(frame('avatar-preview', null, null), 4, 2)],
    ['a truncated header', () => new Uint8Array([0x6c, 0x74, 0x62, 0x66, 1]).buffer],
    [
      'an envelope length past the end',
      () => withByte(frame('avatar-preview', null, null), 8, 200),
    ],
    ['an envelope that is not JSON', () => rawFrame('not json')],
    ['an envelope that is not a LiveThing tuple', () => rawFrame('["avatar-preview",null]')],
    [
      'metadata that is not allowed',
      () => rawFrame('["avatar-preview",null,{"binary":{"size":4}}]'),
    ],
    ['an envelope that is not UTF-8', () => withByte(rawFrame('["a",null,null]'), 9, 0xff)],
  ])('logs and drops a frame with the magic but %s, like broken JSON text', (_name, make) => {
    const { socket, ws } = connected(binary());
    const listener = vi.fn();
    const onError = vi.fn();
    socket.binary.on('avatar-preview', listener);
    socket.onError(onError);

    socket.setDebug(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => ws.emitRaw(make())).not.toThrow();

    expect(listener).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(log.mock.calls.some((call) => String(call[1]).includes('binary'))).toBe(true);
    expect(socket.state.get()).toBe('open');
    log.mockRestore();
  });

  it('reports a binary message with no magic to onError and drops it', () => {
    const { socket, ws } = connected(binary());
    const listener = vi.fn();
    const onError = vi.fn();
    socket.binary.on('avatar-preview', listener);
    socket.onError(onError);

    ws.emitRaw(new Uint8Array([1, 2, 3, 4, 5]).buffer);

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(String(onError.mock.calls[0]![0])).toContain('LiveThing header');
    expect(listener).not.toHaveBeenCalled();
  });

  it('reports a Blob (a platform that ignored binaryType) to onError and drops it', () => {
    const { socket, ws } = connected(binary());
    const onError = vi.fn();
    socket.onError(onError);

    ws.emitRaw(new Blob([picture]));

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('reports every binary message to onError without binary(), as before', () => {
    const socket = client()(connect('wss://test'));
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();
    const onError = vi.fn();

    socket.onError(onError);

    ws.emitRaw(frame('avatar-preview', null, null, picture));

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(String(onError.mock.calls[0]![0])).toContain('Register binary() in client()');
  });
});

function withByte(data: ArrayBuffer, index: number, value: number): ArrayBuffer {
  const copy = new Uint8Array(data.slice(0));
  copy[index] = value;
  return copy.buffer;
}

function rawFrame(envelope: string): ArrayBuffer {
  const text = new TextEncoder().encode(envelope);
  const out = new Uint8Array(9 + text.byteLength);
  out.set([0x6c, 0x74, 0x62, 0x66, 1]);
  new DataView(out.buffer).setUint32(5, text.byteLength);
  out.set(text, 9);

  return out.buffer;
}

describe('binary routing', () => {
  it('does not give a binary frame to a JSON listener with the same name', () => {
    const { socket, ws } = connected(binary());
    const json = vi.fn();
    socket.on('avatar-preview', json);

    ws.emitRaw(frame('avatar-preview', null, null, picture));

    expect(json).not.toHaveBeenCalled();
  });

  it('does not give a JSON frame to a binary listener', () => {
    const { socket, ws } = connected(binary());
    const listener = vi.fn();
    socket.binary.on('avatar-preview', listener);

    ws.emit({ event: 'avatar-preview', payload: { jsonTwin: true }, metadata: null });

    expect(listener).not.toHaveBeenCalled();
  });

  it('routes a channel frame to that channel handle only', () => {
    const { socket, ws } = connected(binary(), channels());
    const general = socket.channel('rooms', 'room:general');
    const design = socket.channel('rooms', 'room:design');
    const onGeneral = vi.fn();
    const onDesign = vi.fn();

    const onJson = vi.fn();
    general.binary.on('screen-frame', onGeneral);
    design.binary.on('screen-frame', onDesign);
    general.on('screen-frame', onJson);

    ws.emitRaw(
      frame(
        'screen-frame',
        { from: 'u_amara' },
        { channel: { name: 'room:general', family: 'rooms' }, delivery: { id: 'm-8', seq: 3 } },
        picture,
      ),
    );

    expect(onGeneral).toHaveBeenCalledWith({ from: 'u_amara' }, expect.any(Uint8Array));
    expect(onDesign).not.toHaveBeenCalled();
    expect(onJson).not.toHaveBeenCalled();
  });

  it('does not give a channel frame to a top-level listener', () => {
    const { socket, ws } = connected(binary(), channels());
    const top = vi.fn();
    socket.binary.on('avatar-preview', top);

    ws.emitRaw(frame('avatar-preview', null, { channel: { name: 'room:general' } }, picture));

    expect(top).not.toHaveBeenCalled();
  });

  it('stops calling a listener after its unsubscribe, and a second call is harmless', () => {
    const { socket, ws } = connected(binary());
    const first = vi.fn();
    const second = vi.fn();
    const off = socket.binary.on('avatar-preview', first);
    socket.binary.on('avatar-preview', second);

    off();
    off();
    ws.emitRaw(frame('avatar-preview', null, null, picture));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('reports a throwing listener and still calls the others', () => {
    const { socket, ws } = connected(binary());
    const onError = vi.fn();
    socket.onError(onError);
    const other = vi.fn();
    socket.binary.on('avatar-preview', () => {
      throw new Error('boom');
    });

    socket.binary.on('avatar-preview', other);

    ws.emitRaw(frame('avatar-preview', null, null, picture));

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('lets intercept() see message.bytes and drop a binary frame with Block', () => {
    const seen: Message[] = [];
    const { socket, ws } = connected(
      binary(),
      intercept((message) => {
        seen.push(message);
        if (message.event === 'avatar-cropped') throw Block;
      }),
    );
    const preview = vi.fn();
    const cropped = vi.fn();
    socket.binary.on('avatar-preview', preview);

    socket.binary.on('avatar-cropped', cropped);

    ws.emitRaw(frame('avatar-preview', null, null, picture));
    ws.emitRaw(frame('avatar-cropped', { width: 1 }, null, picture));

    expect([...seen[0]!.bytes!]).toEqual([...picture]);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(cropped).not.toHaveBeenCalled();
  });

  it('drops a repeated binary frame with dedup()', () => {
    const { socket, ws } = connected(binary(), dedup());
    const listener = vi.fn();
    socket.binary.on('avatar-preview', listener);

    const data = frame('avatar-preview', null, { delivery: { id: 'm-1' } }, picture);
    ws.emitRaw(data);
    ws.emitRaw(data);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('counts the sequence of a binary frame for replay()', () => {
    const { ws } = connected(binary(), dedup(), replay(), reconnection({ maxDelay: 10 }));
    vi.useFakeTimers();
    ws.emitRaw(frame('avatar-preview', null, { delivery: { id: 'm-1', seq: 7 } }, picture));

    ws.serverClose(1006);
    vi.advanceTimersByTime(5_000);
    const next = MockWebSocket.last();
    next.open();

    const replayFrame = next.sentFrames().find((f) => f.event === '__replay__');
    expect(replayFrame?.payload).toEqual({ lastKnownSeq: 7 });
  });

  it('drops a binary reply or stream frame that nothing waits for, without delivering it', () => {
    const { socket, ws } = connected(binary(), clientRequests(), stream());
    const listener = vi.fn();
    const onError = vi.fn();
    socket.onError(onError);
    socket.binary.on('get-thumbnail' as 'avatar-preview', listener);

    socket.binary.on('download-attachment' as 'avatar-preview', listener);

    expect(() => {
      ws.emitRaw(frame('get-thumbnail', null, { exchange: { id: 'req-9' } }, picture));
      ws.emitRaw(
        frame('download-attachment', null, { stream: { id: 'download-1', seq: 1 } }, picture),
      );
    }).not.toThrow();

    expect(listener).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(0);
  });

  it('does not push a binary chunk into a JSON stream with the same id', async () => {
    const { socket, ws } = connected(binary(), stream());
    const handle = await (async () => {
      const started = socket.stream('download-attachment', { attachmentId: 'att_1' });
      const trigger = ws.sentFrames().find((f) => f.event === 'download-attachment');
      const streamId = trigger.metadata.stream.id as string;
      ws.emit({ event: '__streamOk__', payload: null, metadata: { stream: { id: streamId } } });

      return { stream: await started, streamId };
    })();

    ws.emitRaw(
      frame('download-attachment', null, { stream: { id: handle.streamId, seq: 1 } }, picture),
    );
    ws.emit({
      event: 'download-attachment',
      payload: { row: 1 },
      metadata: { stream: { id: handle.streamId, seq: 1 } },
    });
    ws.emit({
      event: '__streamEnd__',
      payload: null,
      metadata: { stream: { id: handle.streamId, seq: 1 } },
    });

    const chunks: unknown[] = [];
    for await (const chunk of handle.stream) chunks.push(chunk);
    expect(chunks).toEqual([{ row: 1 }]);
  });

  it('declines a binary server request at once with a text request-no-response', () => {
    interface Asks {
      serverRequests: { 'capture-screen': { payload: unknown; response: { ok: boolean } } };
    }

    const socket = client<Asks>()(connect('wss://test'), binary(), serverRequests());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const handler = vi.fn(() => ({ ok: true }));
    socket.onRequest('capture-screen', handler);

    const general = { name: 'room:general', family: 'rooms' };
    ws.emitRaw(frame('capture-screen', null, { exchange: { id: 'x-1', source: 'server' } }));
    ws.emitRaw(
      frame('capture-whiteboard', null, {
        exchange: { id: 'x-2', source: 'server' },
        channel: general,
      }),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(ws.sent.every((data) => typeof data === 'string')).toBe(true);
    expect(ws.sentFrames()).toEqual([
      {
        event: '__error__',
        payload: { code: 'request-no-response' },
        metadata: { exchange: { id: 'x-1', source: 'server' } },
      },
      {
        event: '__error__',
        payload: { code: 'request-no-response' },
        metadata: { exchange: { id: 'x-2', source: 'server' }, channel: general },
      },
    ]);
  });

  it('without serverRequests(), gives a binary server request to binary.on, as text does', () => {
    const { socket, ws } = connected(binary());
    const listener = vi.fn();
    const text = vi.fn();
    socket.binary.on('avatar-preview', listener);
    socket.on('avatar-saved', text);

    ws.emitRaw(frame('avatar-preview', null, { exchange: { id: 'x-1', source: 'server' } }));
    ws.emit({
      event: 'avatar-saved',
      payload: { userId: 'u_amara' },
      metadata: { exchange: { id: 'x-2', source: 'server' } },
    });

    expect(text).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(ws.sent).toHaveLength(0);
  });

  it('prints the byte count, not the bytes, in debug logs', () => {
    const { socket, ws } = connected(binary());
    socket.binary.on('avatar-preview', () => {});
    socket.setDebug(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    ws.emitRaw(frame('avatar-preview', null, null, new Uint8Array(12_345)));
    socket.binary.send('upload-avatar', { fileType: 'image/png' }, new Uint8Array(321));

    const lines = log.mock.calls.map((call) => call.map(String).join(' '));
    expect(lines.some((line) => line.includes('<12345 bytes>'))).toBe(true);
    expect(lines.some((line) => line.includes('<321 bytes>'))).toBe(true);
    expect(log.mock.calls.flat().some((value) => value instanceof Uint8Array)).toBe(false);
    log.mockRestore();
  });
});

describe('plugin scoped sockets', () => {
  interface ScreensWire {
    binary: {
      incoming: { 'screen-frame': { from: string } };
      outgoing: { 'share-screen-frame': null };
    };
  }

  interface Host {
    binary: {
      incoming: { '__acme:screens::screen-frame': { from: string } };
      outgoing: { '__acme:screens::share-screen-frame': null };
    };
  }

  it('gets .binary with the plugin prefix in both directions, and its hook sees the bytes', () => {
    const seen: Message[] = [];
    const received = vi.fn();
    let share: (() => boolean) | undefined;
    const Screens = plugin<ScreensWire>()({
      id: 'acme:screens',
      dependencies: [binary],
      setup(socket) {
        socket.onIncoming((message) => {
          seen.push(message);
        });
        socket.binary.on('screen-frame', received);
        share = () => socket.binary.send('share-screen-frame', null, picture);
        return {};
      },
    });
    const socket = client<Host>()(connect('wss://test'), binary(), Screens());

    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    ws.emitRaw(frame('__acme:screens::screen-frame', { from: 'u_kofi' }, null, picture));

    expect(received).toHaveBeenCalledWith({ from: 'u_kofi' }, expect.any(Uint8Array));
    expect(seen[0]!.bytes).toBeInstanceOf(Uint8Array);
    expect(share!()).toBe(true);
    const sent = decodeSent(ws.sent.at(-1));
    expect(sent.event).toBe('__acme:screens::share-screen-frame');

    expect([...sent.bytes!]).toEqual([...picture]);
  });

  it('names binary() when a plugin uses .binary without it', () => {
    const Screens = plugin<ScreensWire>()({
      id: 'acme:screens',
      setup(socket) {
        socket.binary.on('screen-frame', () => {});
        return {};
      },
    });
    // @ts-expect-error: the contract has binary entries and binary() is missing
    expect(() => client<Host>()(connect('wss://test'), Screens())).toThrow(/binary\(\)/);
  });
});

describe('socket.binary.send', () => {
  it('sends one binary frame with the event, the info and the bytes', () => {
    const { socket, ws } = connected(binary());

    expect(socket.binary.send('upload-avatar', { fileType: 'image/png' }, picture)).toBe(true);

    const sent = decodeSent(ws.sent.at(-1));
    expect(sent.event).toBe('upload-avatar');
    expect(sent.payload).toEqual({ fileType: 'image/png' });
    expect(sent.metadata).toBeNull();
    expect([...sent.bytes!]).toEqual([...picture]);
  });

  it('takes an ArrayBuffer, and no bytes at all', () => {
    const { socket, ws } = connected(binary());

    socket.binary.send('upload-avatar', { fileType: 'image/png' }, picture.slice().buffer);
    socket.binary.send('upload-avatar', { fileType: 'image/png' });

    expect([...decodeSent(ws.sent[0]).bytes!]).toEqual([...picture]);
    expect(decodeSent(ws.sent[1]).bytes!.byteLength).toBe(0);
  });

  it('sends on a channel with the channel metadata, once subscribed', async () => {
    const { socket, ws } = connected(binary(), channels());
    const general = socket.channel('rooms', 'room:general');

    expect(() => general.binary.send('share-screen-frame', null, picture)).toThrow(
      expect.objectContaining({ code: 'channel-not-subscribed' }),
    );

    const joined = general.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { channel: { name: 'room:general', family: 'rooms' } },
    });
    await joined;

    expect(general.binary.send('share-screen-frame', null, picture)).toBe(true);
    const sent = decodeSent(ws.sent.at(-1));
    expect(sent.event).toBe('share-screen-frame');
    expect(sent.metadata).toEqual({ channel: { name: 'room:general', family: 'rooms' } });
  });

  it('returns false when the socket is closed and nothing buffers', () => {
    const socket = client<C>()(connect('wss://test'), binary());

    expect(socket.binary.send('upload-avatar', { fileType: 'image/png' }, picture)).toBe(false);
  });

  it('returns false for a reserved event name', () => {
    const { socket, ws } = connected(binary());

    expect(socket.binary.send('__ping__' as 'upload-avatar', { fileType: 'x' }, picture)).toBe(
      false,
    );
    expect(ws.sent).toHaveLength(0);
  });

  it('never sends a frame over maxFrameBytes, counting the whole frame', () => {
    const { socket, ws } = connected(binary({ maxFrameBytes: 100 }));
    const info = { fileType: 'image/png' };
    const envelope = new TextEncoder().encode(
      encodeMessage({ event: 'upload-avatar', payload: info, metadata: null }),
    ).byteLength;
    const fits = 100 - 9 - envelope;

    expect(socket.binary.send('upload-avatar', info, new Uint8Array(fits))).toBe(true);
    expect(socket.binary.send('upload-avatar', info, new Uint8Array(fits + 1))).toBe(false);
    expect(ws.sent).toHaveLength(1);
    expect((ws.sent[0] as Uint8Array).byteLength).toBe(100);
  });

  it('has a 32 MiB default frame limit', () => {
    const { socket, ws } = connected(binary());

    expect(
      socket.binary.send('upload-avatar', { fileType: 'x' }, new Uint8Array(32 * 1024 * 1024)),
    ).toBe(false);
    expect(ws.sent).toHaveLength(0);
  });

  it('takes undefined bytes with options, and sends an empty Uint8Array', () => {
    const { socket, ws } = connected(binary());

    expect(socket.binary.send('upload-avatar', { fileType: 'image/png' }, undefined, {})).toBe(
      true,
    );
    expect(decodeSent(ws.sent[0]).bytes!.byteLength).toBe(0);
  });

  it('throws when the info and metadata are over 64 KiB', () => {
    const { socket } = connected(binary());

    expect(() =>
      socket.binary.send('upload-avatar', { fileType: 'x'.repeat(70_000) }, picture),
    ).toThrow(RangeError);
  });
});

describe('binary.send with buffering()', () => {
  function offline(...extras: Primitive[]) {
    const socket = client<C>()(
      connect('wss://test'),
      binary({ maxFrameBytes: 4096 }),
      buffering({ maxBytes: 1024 }),
      ...(extras as []),
    );
    return socket;
  }

  it('waits in the queue while offline and goes out on open', () => {
    const socket = offline();

    expect(socket.binary.send('upload-avatar', { fileType: 'image/png' }, picture)).toBe(true);
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const sent = decodeSent(ws.sent[0]);
    expect(sent.event).toBe('upload-avatar');
    expect([...sent.bytes!]).toEqual([...picture]);
  });

  it('keeps the bytes as they were when send was called', () => {
    const socket = offline();
    const bytes = picture.slice();

    socket.binary.send('upload-avatar', { fileType: 'image/png' }, bytes);
    bytes[0] = 0;
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    expect([...decodeSent(ws.sent[0]).bytes!]).toEqual([...picture]);
  });

  it('drops a queued frame after its ttl', () => {
    vi.useFakeTimers();
    const socket = offline();

    socket.binary.send('upload-avatar', { fileType: 'image/png' }, picture, { ttl: 100 });
    vi.advanceTimersByTime(200);
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    expect(ws.sent).toHaveLength(0);
  });

  it('counts the whole frame toward maxBytes', () => {
    const socket = offline();
    const info = { fileType: 'image/png' };
    const envelope = new TextEncoder().encode(
      encodeMessage({ event: 'upload-avatar', payload: info, metadata: null }),
    ).byteLength;
    const fits = 1024 - 9 - envelope;

    expect(socket.binary.send('upload-avatar', info, new Uint8Array(fits + 1))).toBe(false);
    expect(socket.binary.send('upload-avatar', info, new Uint8Array(fits))).toBe(true);
    // A second frame pushes the first out: the two together are over maxBytes.
    expect(socket.binary.send('upload-avatar', info, new Uint8Array(1))).toBe(true);
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    expect(ws.sent).toHaveLength(1);
    expect(decodeSent(ws.sent[0]).bytes!.byteLength).toBe(1);
  });

  it('never queues a frame over maxFrameBytes', () => {
    const socket = client<C>()(
      connect('wss://test'),
      binary({ maxFrameBytes: 64 }),
      buffering({ maxBytes: 4096 }),
    );

    expect(socket.binary.send('upload-avatar', { fileType: 'x' }, new Uint8Array(100))).toBe(false);
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    expect(ws.sent).toHaveLength(0);
  });

  it('keeps text and binary frames in the order they were sent', () => {
    interface Mixed {
      outgoing: { typing: null };
      binary: { outgoing: { 'upload-avatar': null } };
    }

    const socket = client<Mixed>()(connect('wss://test'), binary(), buffering());

    socket.send('typing', null);
    socket.binary.send('upload-avatar', null, picture);
    socket.send('typing', null);
    socket.connect();
    const ws = MockWebSocket.last();

    ws.open();

    expect(ws.sent.map((data) => typeof data)).toEqual(['string', 'object', 'string']);
  });
});

describe('a hook cannot change the kind of a frame', () => {
  function freshCopy(message: Message): Message {
    return { event: message.event, payload: message.payload, metadata: message.metadata };
  }

  it('keeps a binary frame binary when an intercept returns a new message without bytes', () => {
    const { socket, ws } = connected(
      binary(),
      channels(),
      intercept((message) => freshCopy(message)),
    );
    const json = vi.fn();
    const top = vi.fn();
    const room = vi.fn();
    socket.on('avatar-preview', json);

    socket.binary.on('avatar-preview', top);
    socket.channel('rooms', 'room:general').binary.on('screen-frame', room);

    ws.emitRaw(frame('avatar-preview', null, null, picture));
    ws.emitRaw(
      frame(
        'screen-frame',
        { from: 'u_amara' },
        { channel: { name: 'room:general', family: 'rooms' } },
        picture,
      ),
    );

    expect(json).not.toHaveBeenCalled();
    expect([...(top.mock.calls[0]![1] as Uint8Array)]).toEqual([...picture]);
    expect(room).toHaveBeenCalledTimes(1);
  });

  it('keeps the bytes of the frame when an intercept returns other bytes', () => {
    const { socket, ws } = connected(
      binary(),
      intercept((message) => ({ ...message, bytes: new Uint8Array([9]) })),
    );
    const top = vi.fn();
    socket.binary.on('avatar-preview', top);

    ws.emitRaw(frame('avatar-preview', null, null, picture));

    expect([...(top.mock.calls[0]![1] as Uint8Array)]).toEqual([...picture]);
  });

  it('ignores an intercept that sets message.bytes in place', () => {
    const { socket, ws } = connected(
      binary(),
      intercept((message) => {
        message.bytes = new Uint8Array([9]);
      }),
    );
    const json = vi.fn();
    const top = vi.fn();
    socket.on('avatar-saved', json);
    socket.binary.on('avatar-saved' as 'avatar-preview', top);

    socket.binary.on('avatar-preview', top);

    ws.emit({ event: 'avatar-saved', payload: { userId: 'u_amara' }, metadata: null });
    ws.emitRaw(frame('avatar-preview', null, null, picture));

    expect(json).toHaveBeenCalledTimes(1);
    expect(top).toHaveBeenCalledTimes(1);
    expect([...(top.mock.calls[0]![1] as Uint8Array)]).toEqual([...picture]);
  });

  it('ignores plugin hooks that set message.bytes in place, in and out', () => {
    interface Wire {
      incoming: { notice: { text: string } };
      outgoing: { typing: null };
      binary: { incoming: { 'screen-frame': null }; outgoing: { 'share-screen-frame': null } };
    }

    interface Host {
      incoming: { '__acme:screens::notice': { text: string } };
      outgoing: { '__acme:screens::typing': null };
      binary: {
        incoming: { '__acme:screens::screen-frame': null };
        outgoing: { '__acme:screens::share-screen-frame': null };
      };
    }

    const json = vi.fn();
    const received = vi.fn();
    let typing: (() => boolean) | undefined;

    let share: (() => boolean) | undefined;
    const Screens = plugin<Wire>()({
      id: 'acme:screens',
      dependencies: [binary],
      setup(scoped) {
        function replace(message: Message): void {
          message.bytes = new Uint8Array([9]);
        }

        scoped.onIncoming(replace);
        scoped.onOutgoing(replace);
        scoped.on('notice', json);
        scoped.binary.on('screen-frame', received);

        typing = () => scoped.send('typing', null);
        share = () => scoped.binary.send('share-screen-frame', null, picture);

        return {};
      },
    });
    const socket = client<Host>()(connect('wss://test'), binary(), Screens());
    socket.connect();
    const ws = MockWebSocket.last();

    ws.open();

    ws.emit({ event: '__acme:screens::notice', payload: { text: 'hi' }, metadata: null });
    ws.emitRaw(frame('__acme:screens::screen-frame', null, null, picture));
    typing!();
    share!();

    expect(json).toHaveBeenCalledTimes(1);
    expect([...(received.mock.calls[0]![1] as Uint8Array)]).toEqual([...picture]);
    expect(typeof ws.sent.at(-2)).toBe('string');
    expect([...decodeSent(ws.sent.at(-1)).bytes!]).toEqual([...picture]);
  });

  it.each([[false], [0], ['']])(
    'ignores a plain-JS intercept that returns %j, as before binary',
    (value) => {
      const { socket, ws } = connected(
        binary(),
        intercept(() => value as never),
      );
      const json = vi.fn();
      const top = vi.fn();
      const onError = vi.fn();
      socket.onError(onError);

      socket.on('avatar-saved', json);
      socket.binary.on('avatar-preview', top);

      ws.emit({ event: 'avatar-saved', payload: { userId: 'u_amara' }, metadata: null });
      ws.emitRaw(frame('avatar-preview', null, null, picture));

      expect(json).toHaveBeenCalledTimes(1);
      expect(top).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it('keeps a text frame text when an intercept adds bytes', () => {
    const { socket, ws } = connected(
      binary(),
      intercept((message) => ({ ...message, bytes: new Uint8Array([9]) })),
    );
    const json = vi.fn();
    socket.on('avatar-saved', json);

    ws.emit({ event: 'avatar-saved', payload: { userId: 'u_amara' }, metadata: null });

    expect(json).toHaveBeenCalledTimes(1);
  });

  it('keeps a binary frame binary through a plugin onIncoming and onOutgoing hook', () => {
    interface ScreensWire {
      incoming: { 'screen-frame': unknown };
      binary: {
        incoming: { 'screen-frame': { from: string } };
        outgoing: { 'share-screen-frame': null };
      };
    }

    interface Host {
      incoming: { '__acme:screens::screen-frame': unknown };
      binary: {
        incoming: { '__acme:screens::screen-frame': { from: string } };
        outgoing: { '__acme:screens::share-screen-frame': null };
      };
    }

    const json = vi.fn();
    const received = vi.fn();
    let share: (() => boolean) | undefined;

    const Screens = plugin<ScreensWire>()({
      id: 'acme:screens',
      dependencies: [binary],
      setup(scoped) {
        scoped.onIncoming((message) => freshCopy(message));
        scoped.onOutgoing((message) => freshCopy(message));
        scoped.on('screen-frame', json);
        scoped.binary.on('screen-frame', received);
        share = () => scoped.binary.send('share-screen-frame', null, picture);

        return {};
      },
    });
    const socket = client<Host>()(connect('wss://test'), binary(), Screens());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    ws.emitRaw(frame('__acme:screens::screen-frame', { from: 'u_kofi' }, null, picture));
    share!();

    expect(json).not.toHaveBeenCalled();
    expect(received).toHaveBeenCalledTimes(1);
    expect([...decodeSent(ws.sent.at(-1)).bytes!]).toEqual([...picture]);
  });
});

describe('binary input checks', () => {
  it('takes an ArrayBuffer from another realm', async () => {
    const { runInNewContext } = await import('node:vm');
    const { socket, ws } = connected(binary());
    const listener = vi.fn();
    socket.binary.on('avatar-preview', listener);

    const local = new Uint8Array(frame('avatar-preview', null, null, picture));
    const foreign = runInNewContext(`new ArrayBuffer(${local.byteLength})`) as ArrayBuffer;
    new Uint8Array(foreign).set(local);
    expect(foreign instanceof ArrayBuffer).toBe(false);

    ws.emitRaw(foreign);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each([['abc'], [null]])('throws an instance of TypeError for bytes %j', (bytes) => {
    const { socket } = connected(binary());

    expect(() =>
      socket.binary.send('upload-avatar', { fileType: 'image/png' }, bytes as never),
    ).toThrow(TypeError);
  });

  it.each([['abc'], [5], [null], [{ length: 3 }]])(
    'throws a clear TypeError for bytes %j',
    (bytes) => {
      const { socket, ws } = connected(binary());

      expect(() =>
        socket.binary.send('upload-avatar', { fileType: 'image/png' }, bytes as never),
      ).toThrow(/\[livething\].*Uint8Array or an ArrayBuffer/);
      expect(ws.sent).toHaveLength(0);
    },
  );
});

describe('testing helpers', () => {
  it('injectBinary runs a binary message through the pipeline to binary.on', () => {
    const socket = client<C>()(connect('wss://test'), binary());
    const listener = vi.fn();
    socket.binary.on('avatar-cropped', listener);

    injectBinary(socket, 'avatar-cropped', { width: 64 }, picture);
    injectBinary(socket, 'avatar-preview', null);

    expect(listener).toHaveBeenCalledWith({ width: 64 }, picture);
  });

  it('injectChannelBinary routes to the channel handle', () => {
    const socket = client<C>()(connect('wss://test'), binary(), channels());
    const listener = vi.fn();
    socket.channel('lobby').binary.on('screen-frame', listener);

    injectChannelBinary(socket, 'lobby', 'screen-frame', { from: 'u_amara' }, picture);

    expect(listener).toHaveBeenCalledWith({ from: 'u_amara' }, picture);
  });

  it('injectChannelBinary reaches one channel of a dynamic family', () => {
    const socket = client<C>()(connect('wss://test'), binary(), channels());
    const general = vi.fn();
    const design = vi.fn();
    socket.channel('rooms', 'room:general').binary.on('screen-frame', general);
    socket.channel('rooms', 'room:design').binary.on('screen-frame', design);

    injectChannelBinary(
      socket,
      { family: 'rooms', name: 'room:general' },
      'screen-frame',
      { from: 'u_amara' },
      picture,
    );

    expect(general).toHaveBeenCalledWith({ from: 'u_amara' }, picture);
    expect(design).not.toHaveBeenCalled();
  });

  it('injectChannel reaches one channel of a dynamic family', () => {
    const socket = client<C>()(connect('wss://test'), binary(), channels());
    const general = vi.fn();
    socket.channel('rooms', 'room:general').on('screen-frame', general);

    injectChannel(socket, { family: 'rooms', name: 'room:general' }, 'screen-frame', 1);

    expect(general).toHaveBeenCalledWith(1);
  });
});
