// `stream({ maxBytes })`: the chunks a loop has not read yet have a byte limit. Over it, the
// stream fails with StreamOverflow.
import {
  encodeBinaryFrame,
  encodeMessage,
  LiveThingConfigError,
  utf8ByteLength,
} from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { StreamOverflow } from '~/errors.ts';
import { binary } from '~/primitives/binary/index.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { stream } from '~/primitives/stream/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface C {
  streams: {
    'export-room': { payload: { roomId: string }; chunk: { line: string }; kind: 'persistent' };
  };
  binary: {
    streams: {
      'download-attachment': {
        payload: { attachmentId: string; fromByte: number };
        chunk: { fileName: string } | null;
        kind: 'ephemeral';
      };
    };
  };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

function build(maxBytes?: number) {
  const socket = client<C>()(
    connect('wss://test'),
    binary(),
    stream(maxBytes === undefined ? {} : { maxBytes }),
    reconnection(),
  );
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

const exportId = 'export-1';

function confirm(ws: MockWebSocket, id: string, durability: 'ephemeral' | 'persistent'): void {
  ws.emit({ event: '__streamOk__', payload: null, metadata: { stream: { id, durability } } });
}

async function startExport(
  { socket, ws }: ReturnType<typeof build>,
  durability: 'ephemeral' | 'persistent' = 'ephemeral',
) {
  const started = socket.stream('export-room', { roomId: 'room:general' }, { streamId: exportId });
  confirm(ws, exportId, durability);

  return { handle: await started, id: exportId };
}

function line(ws: MockWebSocket, seq: number, text: string): void {
  ws.emit({
    event: 'export-room',
    payload: { line: text },
    metadata: { stream: { id: exportId, seq } },
  });
}

function cancels(ws: MockWebSocket): number {
  return ws.sentFrames().filter((frame) => frame.event === '__streamCancel__').length;
}

async function readAll<T>(handle: AsyncIterable<T>): Promise<{ items: T[]; error?: unknown }> {
  const items: T[] = [];
  try {
    for await (const item of handle) items.push(item);
  } catch (error) {
    return { items, error };
  }

  return { items };
}

// `{"line":"…"}` is 11 bytes plus the text.
function payloadBytes(text: string): number {
  return utf8ByteLength(JSON.stringify({ line: text }));
}

describe('stream({ maxBytes })', () => {
  it('fails with StreamOverflow and sends __streamCancel__ when unread chunks go over it', async () => {
    const setup = build(2 * payloadBytes('aaaa'));
    const { handle } = await startExport(setup);

    line(setup.ws, 1, 'aaaa');
    line(setup.ws, 2, 'bbbb');
    expect(cancels(setup.ws)).toBe(0);
    line(setup.ws, 3, 'cccc');

    const { items, error } = await readAll(handle);
    expect(items).toEqual([{ line: 'aaaa' }, { line: 'bbbb' }]);
    expect(StreamOverflow.matches(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'stream-overflow',
      detail: { maxBytes: 2 * payloadBytes('aaaa') },
    });
    expect(cancels(setup.ws)).toBe(1);
  });

  it('counts UTF-8 bytes, not characters', async () => {
    const setup = build(payloadBytes('éé') - 1);
    const { handle } = await startExport(setup);

    line(setup.ws, 1, 'éé');

    expect((await readAll(handle)).error).toMatchObject({ code: 'stream-overflow' });
  });

  it('does not count a chunk the loop was waiting for, and frees what the loop read', async () => {
    const setup = build(payloadBytes('aaaa'));
    const { handle } = await startExport(setup);
    const iterator = handle[Symbol.asyncIterator]();

    const waiting = iterator.next();
    line(setup.ws, 1, 'aaaa');
    await expect(waiting).resolves.toEqual({ done: false, value: { line: 'aaaa' } });

    line(setup.ws, 2, 'bbbb');
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { line: 'bbbb' } });
    line(setup.ws, 3, 'cccc');
    setup.ws.emit({
      event: '__streamEnd__',
      payload: null,
      metadata: { stream: { id: exportId, seq: 3 } },
    });

    expect(await readAll({ [Symbol.asyncIterator]: () => iterator })).toEqual({
      items: [{ line: 'cccc' }],
    });
    expect(cancels(setup.ws)).toBe(0);
  });

  it('fails a durable stream but does not cancel it', async () => {
    const setup = build(payloadBytes('aaaa'));
    const { handle } = await startExport(setup, 'persistent');

    line(setup.ws, 1, 'aaaa');
    line(setup.ws, 2, 'bbbb');

    expect((await readAll(handle)).error).toMatchObject({ code: 'stream-overflow' });
    expect(cancels(setup.ws)).toBe(0);
  });

  it('counts the info and the bytes of a binary chunk, 16 MiB by default', async () => {
    const setup = build();
    const id = 'download-1';
    const started = setup.socket.binary.stream(
      'download-attachment',
      { attachmentId: 'att_1', fromByte: 0 },
      undefined,
      { streamId: id },
    );
    confirm(setup.ws, id, 'ephemeral');
    const download = await started;

    // `null` info is 4 bytes, so 16 MiB - 4 bytes of bytes fits exactly.
    const fits = new Uint8Array(16 * 1024 * 1024 - 4);
    function chunk(seq: number, bytes: Uint8Array): void {
      setup.ws.emitRaw(
        encodeBinaryFrame(
          encodeMessage({
            event: 'download-attachment',
            payload: null,
            metadata: { stream: { id, seq } },
          }),
          bytes,
        ).buffer,
      );
    }

    chunk(1, fits);
    expect(cancels(setup.ws)).toBe(0);
    chunk(2, new Uint8Array(1));

    const { items, error } = await readAll(download);
    expect(items).toHaveLength(1);
    expect(error).toMatchObject({
      code: 'stream-overflow',
      detail: { maxBytes: 16 * 1024 * 1024 },
    });
    expect(cancels(setup.ws)).toBe(1);
  });

  it('refuses a maxBytes that is not a positive integer', () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => stream({ maxBytes })).toThrow(LiveThingConfigError);
    }
  });
});
