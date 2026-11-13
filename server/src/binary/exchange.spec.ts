/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import { encodeBinaryFrame, splitBinaryFrame } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { binary } from '~/binary/capability.ts';
import { channels } from '~/channel/capability.ts';
import { emits } from '~/emits/emits.ts';
import { errors } from '~/errors/capability.ts';
import { error } from '~/errors/errors.ts';
import { clientRequests } from '~/request/client-requests.ts';
import { serverRequests } from '~/request/server-requests.ts';
import { stream } from '~/stream/capability.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { TransportFrame } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';

const general = { channel: { name: 'room:general', family: 'rooms' } };
const thumbnail = new Uint8Array([137, 80, 78, 71]);
const NO_BYTES = new Uint8Array(0);
const AttachmentNotFound = error('attachment-not-found', v.object({ attachmentId: v.string() }));

function frameOf(event: string, info: unknown, metadata: unknown): Uint8Array {
  return encodeBinaryFrame(JSON.stringify([event, info, metadata]), NO_BYTES);
}

function frameWithBytes(
  envelope: [event: string, info: unknown, metadata: unknown],
  bytes: Uint8Array,
) {
  return encodeBinaryFrame(JSON.stringify(envelope), bytes);
}

/** Keep an Error's message when a log line is turned into text. */
function errorText(_key: string, value: unknown): unknown {
  return value instanceof Error ? value.message : value;
}

function textOf(event: string, payload: unknown, metadata: unknown): string {
  return JSON.stringify([event, payload, metadata]);
}

function start(definition: ServerDefinition, logged: string[] = []): Engine {
  let engine!: Engine;
  adapter({
    id: 'binary-exchange-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql: createTestSql(), kv: createTestKV() },
        timers: createTestTimers(),
        platform: {},
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: (...args: unknown[]) => logged.push(JSON.stringify(args, errorText)),
        },
      });
      return {};
    },
  })(definition, undefined as never);
  return engine;
}

async function connect(engine: Engine, userId = 'u_amara') {
  await engine.initialize();
  const sent: TransportFrame[] = [];
  const handle = engine.accept(Symbol(userId), {
    send: (data: TransportFrame) => sent.push(data),
    close: () => {},
    bufferedAmount: () => 0,
    userId,
  });
  const connection = [...engine.core.connections.values()].at(-1)!;
  await connection.lifecycleReady;

  /** Every frame in the order it was sent: text as JSON, binary as its envelope and bytes. */
  function frames(): { kind: 'text' | 'bytes'; envelope: unknown[]; bytes?: number[] }[] {
    return sent.map((data) => {
      if (data.kind === 'text') return { kind: 'text', envelope: JSON.parse(data.text) };

      const split = splitBinaryFrame(data.bytes);
      if (split.kind !== 'frame') throw new Error('the server sent a broken binary frame');

      return { kind: 'bytes', envelope: JSON.parse(split.envelope), bytes: [...split.bytes] };
    });
  }

  return {
    handle,
    connection,
    frames,
    errorCodes: () =>
      frames()
        .filter((data) => data.envelope[0] === '__error__')
        .map((data) => (data.envelope[1] as { code: string }).code),
    subscribe: () => handle.handleMessage(textOf('__subscribe__', {}, general)),
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('base.binary.request', () => {
  function huddle(seen: unknown[]) {
    const base = server({
      capabilities: [binary(), channels(), clientRequests(), errors([AttachmentNotFound])],
    });
    const rooms = base.channel(['rooms', 'room:{roomId}'], {});
    const handleGetThumbnail = base.binary.request('get-thumbnail', {
      input: v.object({ attachmentId: v.string() }),
      maxBytes: 8,
      run(_ctx, input, bytes) {
        seen.push({ input, bytes: [...bytes] });
        if (input.attachmentId === 'att_missing') {
          throw AttachmentNotFound({ attachmentId: input.attachmentId });
        }

        return { info: { fileType: 'image/png' }, bytes: thumbnail };
      },
    });
    const handleGetRoomIcon = rooms.binary.request('get-room-icon', {
      run(ctx) {
        return { info: null, bytes: new TextEncoder().encode(ctx.channel.name) };
      },
    });

    return base.assemble({ handlers: [handleGetThumbnail, handleGetRoomIcon] });
  }

  const exchange = { exchange: { id: 'request-7', source: 'client' } };

  it('replies with one binary frame with the same exchange, the info and the bytes', async () => {
    const seen: unknown[] = [];
    const { handle, frames } = await connect(start(huddle(seen)));

    await handle.handleBinaryMessage(frameOf('get-thumbnail', { attachmentId: 'att_1' }, exchange));

    expect(seen).toEqual([{ input: { attachmentId: 'att_1' }, bytes: [] }]);
    expect(frames()).toEqual([
      {
        kind: 'bytes',
        envelope: ['get-thumbnail', { fileType: 'image/png' }, exchange],
        bytes: [...thumbnail],
      },
    ]);
  });

  it('replies with the normal text __error__ when run throws a registered error', async () => {
    const { handle, frames } = await connect(start(huddle([])));

    await handle.handleBinaryMessage(
      frameOf('get-thumbnail', { attachmentId: 'att_missing' }, exchange),
    );

    expect(frames()).toEqual([
      {
        kind: 'text',
        envelope: [
          '__error__',
          { code: 'attachment-not-found', detail: { attachmentId: 'att_missing' } },
          exchange,
        ],
      },
    ]);
  });

  it('checks the info with input and the bytes with maxBytes', async () => {
    const seen: unknown[] = [];
    const { handle, errorCodes } = await connect(start(huddle(seen)));

    await handle.handleBinaryMessage(frameOf('get-thumbnail', { attachmentId: 7 }, exchange));
    await handle.handleBinaryMessage(
      frameWithBytes(['get-thumbnail', { attachmentId: 'att_1' }, exchange], new Uint8Array(9)),
    );

    expect(errorCodes()).toEqual(['validation-failed', 'validation-failed']);
    expect(seen).toEqual([]);
  });

  it('answers wrong-frame-kind to a text frame', async () => {
    const seen: unknown[] = [];
    const { handle, errorCodes } = await connect(start(huddle(seen)));

    await handle.handleMessage(textOf('get-thumbnail', { attachmentId: 'att_1' }, exchange));

    expect(errorCodes()).toEqual(['wrong-frame-kind']);
    expect(seen).toEqual([]);
  });

  it('works in a channel, and a null info goes out as null', async () => {
    const { handle, frames, subscribe } = await connect(start(huddle([])));
    await subscribe();

    await handle.handleBinaryMessage(
      frameOf('get-room-icon', null, { ...general, exchange: exchange.exchange }),
    );

    expect(frames().at(-1)).toEqual({
      kind: 'bytes',
      envelope: ['get-room-icon', null, { exchange: exchange.exchange, ...general }],
      bytes: [...new TextEncoder().encode('room:general')],
    });
  });

  it('replies with a binary frame with zero bytes when run returns only the info', async () => {
    const base = server({ capabilities: [binary(), clientRequests()] });
    const handleGetAvatar = base.binary.request('get-avatar', { run: () => ({ info: null }) });
    const { handle, frames } = await connect(start(base.assemble({ handlers: [handleGetAvatar] })));

    await handle.handleBinaryMessage(frameOf('get-avatar', null, exchange));

    expect(frames()).toEqual([
      { kind: 'bytes', envelope: ['get-avatar', null, exchange], bytes: [] },
    ]);
  });

  it('needs clientRequests(), and binary()', () => {
    const noRequests = server({ capabilities: [binary()] }) as any;
    expect(() => noRequests.binary.request('get-thumbnail', { run() {} })).toThrow(
      /base\.binary\.request\(\) needs clientRequests\(\)/,
    );

    const noBinary = server({ capabilities: [clientRequests(), channels()] }) as any;
    expect(() => noBinary.binary.request('get-thumbnail', { run() {} })).toThrow(
      /base\.binary\.request\(\) needs binary\(\)/,
    );
    expect(() =>
      noBinary.channel('lobby', {}).binary.request('get-room-icon', { run() {} }),
    ).toThrow(/binary\(\) is not listed/);
  });
});

describe('base.binary.stream', () => {
  function huddle(log: string[], options: { broadcast?: boolean; fail?: boolean } = {}) {
    const base = server({ capabilities: [binary(), channels(), stream()] });
    const rooms = base.channel(['rooms', 'room:{roomId}'], {});
    const handleDownloadAttachment = base.binary.stream('download-attachment', {
      input: v.object({ attachmentId: v.string(), fromByte: v.number() }),
      nudges: { 'pause-download': null },
      broadcast: options.broadcast,
      async *run(ctx, input, bytes) {
        log.push(
          `start ${input.attachmentId} from ${input.fromByte} with ${bytes.byteLength} bytes`,
        );
        ctx.stream.signal.addEventListener('abort', () => log.push('aborted'));
        const nudges = ctx.stream.nudges(
          yield {
            info: { fileName: 'launch-plan.pdf', fileType: 'application/pdf' },
            bytes: new Uint8Array([1]),
          },
        );
        log.push(...nudges.map((nudge) => nudge.event));
        await ctx.stream.drain();

        yield { info: null, bytes: new Uint8Array([2, 2]) };
        if (options.fail) throw new Error('the disk went away');

        yield { info: null, bytes: new Uint8Array([3]).buffer };
      },
    });
    const handleDownloadRecording = rooms.binary.stream('download-recording', {
      async *run(ctx) {
        yield { info: { room: ctx.channel.name }, bytes: new Uint8Array([9]) };
      },
    });

    return base.assemble({ handlers: [handleDownloadAttachment, handleDownloadRecording] });
  }

  it('sends each chunk as a binary frame, with __streamOk__ and __streamEnd__ as text', async () => {
    const log: string[] = [];
    const { handle, frames } = await connect(start(huddle(log)));

    await handle.handleBinaryMessage(
      frameOf(
        'download-attachment',
        { attachmentId: 'att_1', fromByte: 0 },
        { stream: { id: 'download-1' } },
      ),
    );

    function chunk(seq: number) {
      return { stream: { id: 'download-1', durability: 'ephemeral', seq } };
    }

    expect(frames()).toEqual([
      {
        kind: 'text',
        envelope: ['__streamOk__', null, { stream: { id: 'download-1', durability: 'ephemeral' } }],
      },
      {
        kind: 'bytes',
        envelope: [
          'download-attachment',
          { fileName: 'launch-plan.pdf', fileType: 'application/pdf' },
          chunk(1),
        ],
        bytes: [1],
      },
      { kind: 'bytes', envelope: ['download-attachment', null, chunk(2)], bytes: [2, 2] },
      { kind: 'bytes', envelope: ['download-attachment', null, chunk(3)], bytes: [3] },
      {
        kind: 'text',
        envelope: ['__streamEnd__', null, { stream: { id: 'download-1', seq: 3 } }],
      },
    ]);
    expect(log).toEqual(['start att_1 from 0 with 0 bytes']);
  });

  it('ends with a text __error__ with stream.terminated when the generator throws', async () => {
    const { handle, frames } = await connect(start(huddle([], { fail: true })));

    await handle.handleBinaryMessage(
      frameOf(
        'download-attachment',
        { attachmentId: 'att_1', fromByte: 0 },
        { stream: { id: 'download-1' } },
      ),
    );

    expect(frames().at(-1)).toEqual({
      kind: 'text',
      envelope: [
        '__error__',
        { code: 'internal-error' },
        { stream: { id: 'download-1', terminated: true } },
      ],
    });
  });

  it('stops on a text __streamCancel__ and fires ctx.stream.signal', async () => {
    const log: string[] = [];
    const base = server({ capabilities: [binary(), stream()] });
    const handleDownloadAttachment = base.binary.stream('download-attachment', {
      async *run(ctx) {
        yield { info: null, bytes: new Uint8Array([1]) };
        await new Promise((resolve) => ctx.stream.signal.addEventListener('abort', resolve));
        log.push('aborted');
      },
    });
    const { handle, frames, connection } = await connect(
      start(base.assemble({ handlers: [handleDownloadAttachment] })),
    );

    void handle.handleBinaryMessage(
      frameOf('download-attachment', null, { stream: { id: 'download-1' } }),
    );
    await tick();
    // A hibernation wake ends every stream in this list with stream-aborted, as for JSON.
    expect(connection.activeStreamIds?.has('download-1')).toBe(true);
    await handle.handleMessage(textOf('__streamCancel__', null, { stream: { id: 'download-1' } }));

    expect(log).toEqual(['aborted']);
    expect(frames().map((data) => [data.kind, data.envelope[0]])).toEqual([
      ['text', '__streamOk__'],
      ['bytes', 'download-attachment'],
    ]);
  });

  it('takes a text nudge, and answers wrong-frame-kind to a binary one', async () => {
    const log: string[] = [];
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    const base = server({ capabilities: [binary(), stream()] });
    const handleDownloadAttachment = base.binary.stream('download-attachment', {
      nudges: { 'pause-download': null },
      async *run(ctx) {
        await paused;
        const nudges = ctx.stream.nudges(yield { info: null, bytes: new Uint8Array([1]) });
        log.push(...nudges.map((nudge) => nudge.event));
      },
    });

    const { handle, frames, errorCodes } = await connect(
      start(base.assemble({ handlers: [handleDownloadAttachment] })),
    );

    const running = handle.handleBinaryMessage(
      frameOf('download-attachment', null, { stream: { id: 'download-1' } }),
    );
    await tick();
    await handle.handleBinaryMessage(
      frameOf('pause-download', null, { stream: { id: 'download-1', nudgeId: 'n-1' } }),
    );
    await handle.handleMessage(
      textOf('pause-download', null, { stream: { id: 'download-1', nudgeId: 'n-2' } }),
    );
    resume();

    await running;

    expect(errorCodes()).toEqual(['wrong-frame-kind']);
    expect(frames().find((data) => data.envelope[0] === '__nudgeOk__')?.envelope[2]).toEqual({
      stream: { id: 'download-1', nudgeId: 'n-2' },
    });
    expect(log).toEqual(['pause-download']);
  });

  it('answers wrong-frame-kind to a text start', async () => {
    const log: string[] = [];
    const { handle, errorCodes } = await connect(start(huddle(log)));

    await handle.handleMessage(
      textOf(
        'download-attachment',
        { attachmentId: 'att_1', fromByte: 0 },
        { stream: { id: 'download-1' } },
      ),
    );

    expect(errorCodes()).toEqual(['wrong-frame-kind']);
    expect(log).toEqual([]);
  });

  it('sends a broadcast stream to every connection as binary chunks', async () => {
    const engine = start(huddle([], { broadcast: true }));
    const amara = await connect(engine, 'u_amara');
    const kofi = await connect(engine, 'u_kofi');

    await amara.handle.handleBinaryMessage(
      frameOf(
        'download-attachment',
        { attachmentId: 'att_1', fromByte: 0 },
        { stream: { id: 'download-1' } },
      ),
    );

    expect(kofi.frames().map((data) => [data.kind, data.envelope[0], data.bytes])).toEqual([
      ['bytes', 'download-attachment', [1]],
      ['bytes', 'download-attachment', [2, 2]],
      ['bytes', 'download-attachment', [3]],
      ['text', '__streamEnd__', undefined],
    ]);
  });

  it('works in a channel', async () => {
    const { handle, frames, subscribe } = await connect(start(huddle([])));
    await subscribe();

    await handle.handleBinaryMessage(
      frameOf('download-recording', null, { ...general, stream: { id: 'rec-1' } }),
    );

    expect(frames().find((data) => data.kind === 'bytes')?.envelope).toEqual([
      'download-recording',
      { room: 'room:general' },
      {
        channel: { name: 'room:general', family: 'rooms' },
        stream: { id: 'rec-1', durability: 'ephemeral', seq: 1 },
      },
    ]);
  });

  it('checks the bytes of the frame that starts it with maxBytes', async () => {
    const log: string[] = [];
    const base = server({ capabilities: [binary(), stream()] });
    const handleDownloadAttachment = base.binary.stream('download-attachment', {
      maxBytes: 2,
      async *run(_ctx, _input, bytes) {
        log.push(`started with ${bytes.byteLength} bytes`);
        yield { info: null, bytes };
      },
    });
    const { handle, errorCodes } = await connect(
      start(base.assemble({ handlers: [handleDownloadAttachment] })),
    );
    function startWith(id: string, bytes: Uint8Array) {
      return frameWithBytes(['download-attachment', null, { stream: { id } }], bytes);
    }

    await handle.handleBinaryMessage(startWith('d-1', new Uint8Array(3)));
    await handle.handleBinaryMessage(startWith('d-2', new Uint8Array(2)));

    expect(errorCodes()).toEqual(['validation-failed']);
    expect(log).toEqual(['started with 2 bytes']);
  });

  it('needs stream()', () => {
    const noStream = server({ capabilities: [binary(), channels()] }) as any;
    expect(() => noStream.binary.stream('download-attachment', { async *run() {} })).toThrow(
      /base\.binary\.stream\(\) needs the stream\(\) capability/,
    );
  });
});

describe('a JSON and binary mix-up when sending', () => {
  it('says which kind the event is declared as, and which method sends it', async () => {
    const thrown: string[] = [];
    const base = server({
      capabilities: [
        binary({ emits: { 'avatar-preview': t<null>() } }),
        emits({ notification: t<{ title: string }>() }),
      ],
    });
    const handleRename = base.on('rename', {
      run(ctx) {
        for (const send of [
          () => (ctx as any).send('avatar-preview', null),
          () => (ctx as any).binary.send('notification', { title: 'Hi' }),
        ]) {
          try {
            send();
          } catch (caught) {
            thrown.push((caught as Error).message);
          }
        }
      },
    });
    const { handle } = await connect(start(base.assemble({ handlers: [handleRename] })));

    await handle.handleMessage(textOf('rename', null, null));

    expect(thrown).toEqual([
      '[livething] Outgoing event "avatar-preview" is declared in binary({ emits }). Send it with .binary.send(...), not .send(...).',
      '[livething] Outgoing event "notification" is declared as a JSON event. Send it with .send(...), not .binary.send(...).',
    ]);
  });
});

describe('a bad reply or chunk from plain JavaScript', () => {
  function huddle(reply: unknown, chunk: unknown) {
    const base = server({ capabilities: [binary(), clientRequests(), stream()] });
    const handleGetThumbnail = base.binary.request('get-thumbnail', {
      run: () => reply as never,
    });
    const handleDownloadAttachment = base.binary.stream('download-attachment', {
      async *run() {
        yield chunk as never;
      },
    });
    return base.assemble({ handlers: [handleGetThumbnail, handleDownloadAttachment] });
  }

  it.each([
    ['a string', 'image/png'],
    ['nothing', undefined],
    ['bytes of the wrong type', { info: null, bytes: 'png' }],
  ])('makes a binary request that returns %s reply internal-error', async (_name, reply) => {
    const logged: string[] = [];
    const exchange = { exchange: { id: 'r-1', source: 'client' } };
    const { handle, frames } = await connect(start(huddle(reply, null), logged));

    await handle.handleBinaryMessage(frameOf('get-thumbnail', null, exchange));

    expect(frames()).toEqual([
      { kind: 'text', envelope: ['__error__', { code: 'internal-error' }, exchange] },
    ]);
    expect(logged.join('\n')).toContain("[livething] binary.request('get-thumbnail')");
  });

  it.each([
    ['a string', 'piece'],
    ['an object with no bytes', { info: null }],
    ['bytes of the wrong type', { info: null, bytes: [1, 2] }],
  ])('ends a binary stream whose chunk is %s with the terminal error', async (_name, chunk) => {
    const logged: string[] = [];
    const { handle, frames } = await connect(start(huddle(null, chunk), logged));

    await handle.handleBinaryMessage(
      frameOf('download-attachment', null, { stream: { id: 'download-1' } }),
    );

    expect(frames().map((data) => data.kind)).toEqual(['text', 'text']);
    expect(frames().at(-1)!.envelope).toEqual([
      '__error__',
      { code: 'internal-error' },
      { stream: { id: 'download-1', terminated: true } },
    ]);
    expect(logged.join('\n')).toContain("[livething] binary.stream('download-attachment')");
  });
});

describe('ctx.matches and ctx.unsafeCast with binary requests and streams', () => {
  it('match a binary frame for the handler, checked by its input, and never a text one', async () => {
    const results: unknown[] = [];
    const base = server({
      capabilities: [binary(), channels(), clientRequests(), stream()],
      intercept(ctx, interceptFrame) {
        if (interceptFrame.event === 'get-thumbnail') {
          results.push(ctx.matches('get-thumbnail', interceptFrame));
          results.push(ctx.matches('get-thumbnail', { ...interceptFrame, bytes: undefined }));
          const cast = ctx.unsafeCast('get-thumbnail', interceptFrame);
          results.push((cast.payload as { attachmentId: string }).attachmentId);
        }

        if (interceptFrame.event === 'download-attachment') {
          results.push(ctx.matches('download-attachment', interceptFrame));
          results.push(ctx.matches('download-attachment', { ...interceptFrame, bytes: undefined }));
        }

        if (interceptFrame.event === 'download-recording') {
          results.push(ctx.matches('@rooms::download-recording', interceptFrame));
        }
      },
    });
    const rooms = base.channel(['rooms', 'room:{roomId}'], {});
    const handleGetThumbnail = base.binary.request('get-thumbnail', {
      input: v.object({ attachmentId: v.string() }),
      run: () => ({ info: null }),
    });
    const handleDownloadAttachment = base.binary.stream('download-attachment', {
      input: v.object({ attachmentId: v.string(), fromByte: v.number() }),
      async *run() {},
    });

    const handleDownloadRecording = rooms.binary.stream('download-recording', {
      async *run() {},
    });
    const { handle, subscribe } = await connect(
      start(
        base.assemble({
          handlers: [handleGetThumbnail, handleDownloadAttachment, handleDownloadRecording],
        }),
      ),
    );
    await subscribe();

    await handle.handleBinaryMessage(
      frameOf(
        'get-thumbnail',
        { attachmentId: 'att_1' },
        { exchange: { id: 'r-1', source: 'client' } },
      ),
    );
    await handle.handleBinaryMessage(
      frameOf(
        'download-attachment',
        { attachmentId: 'att_1', fromByte: 0 },
        { stream: { id: 's-1' } },
      ),
    );
    await handle.handleBinaryMessage(
      frameOf('download-recording', null, { ...general, stream: { id: 's-2' } }),
    );

    expect(results).toEqual([true, false, 'att_1', true, false, true]);
  });
});

describe('ctx.binary.request', () => {
  const answerSchema = v.object({ fileType: v.literal('image/png') });

  function huddle(results: unknown[]) {
    const base = server({
      capabilities: [
        binary({
          serverRequests: {
            'capture-screen': { out: t<{ maxWidth: number }>(), in: answerSchema },
            'capture-camera': { out: t<null>() },
          },
        }),
        channels(),
        serverRequests({ 'confirm-leave': { out: t<null>() } }),
      ],
    });
    const rooms = base.channel(['rooms', 'room:{roomId}'], {
      capabilities: [
        binary({ serverRequests: { 'capture-whiteboard': { out: t<null>(), in: v.null() } } }),
      ],
    });
    function settle(promise: Promise<unknown>) {
      promise.then(
        (value) => results.push(value),
        (reason: unknown) => results.push((reason as { code?: string }).code ?? reason),
      );
    }

    const handleStartScreenShare = base.on('start-screen-share', {
      run(ctx) {
        settle(ctx.binary.request('capture-screen', { maxWidth: 1280 }));
      },
    });
    const handleShareWithKofi = base.on('ask-kofi-for-screen', {
      run(ctx) {
        const kofi = ctx.users.get('u_kofi');
        settle(
          kofi.binary.request('capture-screen', { maxWidth: 640 }, undefined, { timeout: 50 }),
        );
      },
    });
    const handleAskConnection = base.on('ask-connection-for-screen', {
      run(ctx) {
        settle(
          ctx.connections.get(ctx.connection).binary.request('capture-screen', { maxWidth: 1 }),
        );
      },
    });
    const handleWrongKind = base.on('mix-up-requests', {
      run(ctx) {
        for (const promise of [
          (ctx as any).request('capture-screen', { maxWidth: 1 }),
          (ctx as any).binary.request('confirm-leave', null),
        ]) {
          (promise as Promise<unknown>).catch((reason: { code: string; message: string }) =>
            results.push(`${reason.code}: ${reason.message}`),
          );
        }
      },
    });
    const handleLeaveHuddle = base.on('leave-huddle', {
      run(ctx) {
        settle(ctx.request('confirm-leave', null));
      },
    });

    const handleStartCamera = base.on('start-camera', {
      run(ctx) {
        settle(ctx.binary.request('capture-camera', null));
      },
    });

    const handleShareWhiteboard = rooms.on('share-whiteboard', {
      run(ctx) {
        settle(ctx.channel.binary.request('capture-whiteboard', null, new Uint8Array([7])));
      },
    });

    return base.assemble({
      handlers: [
        handleStartScreenShare,
        handleShareWithKofi,
        handleAskConnection,
        handleWrongKind,
        handleLeaveHuddle,
        handleStartCamera,
        handleShareWhiteboard,
      ],
    });
  }

  async function ask(event = 'start-screen-share') {
    const results: unknown[] = [];
    const amara = await connect(start(huddle(results)));
    await amara.handle.handleMessage(textOf(event, null, null));
    const request = amara.frames().at(-1)!;
    const { id } = (request.envelope[2] as { exchange: { id: string } }).exchange;

    const answer = { exchange: { id, source: 'server' } };

    return { ...amara, results, request, answer };
  }

  it('sends one binary frame, and resolves a binary answer with the checked info and the bytes', async () => {
    const { handle, request, answer, results } = await ask();

    expect(request).toEqual({
      kind: 'bytes',
      envelope: [
        'capture-screen',
        { maxWidth: 1280 },
        { exchange: { id: expect.any(String), source: 'server' } },
      ],
      bytes: [],
    });

    await handle.handleBinaryMessage(
      frameWithBytes(['capture-screen', { fileType: 'image/png' }, answer], thumbnail),
    );
    await tick();

    expect(results).toEqual([{ info: { fileType: 'image/png' }, bytes: thumbnail }]);
  });

  it('rejects a text answer with request-invalid-response', async () => {
    const { handle, answer, results } = await ask();

    await handle.handleMessage(textOf('capture-screen', { fileType: 'image/png' }, answer));
    await tick();

    expect(results).toEqual(['request-invalid-response']);
  });

  it('rejects a binary answer to a JSON ctx.request with request-invalid-response', async () => {
    const { handle, request, answer, results } = await ask('leave-huddle');
    expect(request.kind).toBe('text');

    await handle.handleBinaryMessage(frameOf('confirm-leave', null, answer));
    await tick();

    expect(results).toEqual(['request-invalid-response']);
  });

  it('takes a text __error__ as a decline, and a binary __error__ as a wrong-kind answer', async () => {
    const declined = await ask();
    await declined.handle.handleMessage(
      textOf('__error__', { code: 'request-no-response' }, declined.answer),
    );
    await tick();
    expect(declined.results).toEqual(['request-no-response']);

    const binaryError = await ask();
    await binaryError.handle.handleBinaryMessage(
      frameOf('__error__', { code: 'request-no-response' }, binaryError.answer),
    );
    await tick();
    expect(binaryError.results).toEqual(['request-invalid-response']);
  });

  it('rejects a binary __error__ as a wrong-kind answer, even with no in schema', async () => {
    const { handle, answer, results } = await ask('start-camera');

    await handle.handleBinaryMessage(frameOf('__error__', { code: 'request-no-response' }, answer));
    await tick();

    expect(results).toEqual(['request-invalid-response']);
  });

  it('rejects a binary answer whose info fails in', async () => {
    const { handle, answer, results } = await ask();

    await handle.handleBinaryMessage(frameOf('capture-screen', { fileType: 'image/gif' }, answer));
    await tick();

    expect(results).toEqual(['request-invalid-response']);
  });

  it('asks one connection by ref', async () => {
    const { handle, request, answer, results } = await ask('ask-connection-for-screen');
    expect(request.envelope.slice(0, 2)).toEqual(['capture-screen', { maxWidth: 1 }]);

    await handle.handleBinaryMessage(frameOf('capture-screen', { fileType: 'image/png' }, answer));
    await tick();

    expect(results).toEqual([{ info: { fileType: 'image/png' }, bytes: NO_BYTES }]);
  });

  it('rejects with timeout when nobody answers within the timeout option', async () => {
    const results: unknown[] = [];
    const engine = start(huddle(results));
    const amara = await connect(engine, 'u_amara');
    await connect(engine, 'u_kofi');

    await amara.handle.handleMessage(textOf('ask-kofi-for-screen', null, null));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(results).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(results).toEqual(['timeout']);
  });

  it('asks every socket of a user, ignores a text answer, and takes the first binary one', async () => {
    const results: unknown[] = [];
    const engine = start(huddle(results));
    const amara = await connect(engine, 'u_amara');
    const kofiPhone = await connect(engine, 'u_kofi');
    const kofiLaptop = await connect(engine, 'u_kofi');

    await amara.handle.handleMessage(textOf('ask-kofi-for-screen', null, null));
    function answerOf(socket: typeof kofiPhone) {
      const { exchange } = socket.frames().at(-1)!.envelope[2] as { exchange: { id: string } };
      return { exchange: { id: exchange.id, source: 'server' } };
    }

    await kofiPhone.handle.handleMessage(
      textOf('capture-screen', { fileType: 'image/png' }, answerOf(kofiPhone)),
    );
    await kofiLaptop.handle.handleBinaryMessage(
      frameWithBytes(
        ['capture-screen', { fileType: 'image/png' }, answerOf(kofiLaptop)],
        thumbnail,
      ),
    );
    await tick();

    expect(results).toEqual([
      {
        info: { fileType: 'image/png' },
        bytes: thumbnail,
        from: expect.objectContaining({ id: kofiLaptop.connection.id }),
      },
    ]);
  });

  it('asks every socket of a user, and ignores a binary answer whose info fails in', async () => {
    const results: unknown[] = [];
    const engine = start(huddle(results));
    const amara = await connect(engine, 'u_amara');
    const kofiPhone = await connect(engine, 'u_kofi');
    const kofiLaptop = await connect(engine, 'u_kofi');

    await amara.handle.handleMessage(textOf('ask-kofi-for-screen', null, null));
    function answerOf(socket: typeof kofiPhone) {
      const { exchange } = socket.frames().at(-1)!.envelope[2] as { exchange: { id: string } };
      return { exchange: { id: exchange.id, source: 'server' } };
    }

    await kofiPhone.handle.handleBinaryMessage(
      frameOf('capture-screen', { fileType: 'image/gif' }, answerOf(kofiPhone)),
    );
    await tick();
    expect(results).toEqual([]);

    await kofiLaptop.handle.handleBinaryMessage(
      frameWithBytes(
        ['capture-screen', { fileType: 'image/png' }, answerOf(kofiLaptop)],
        thumbnail,
      ),
    );
    await tick();

    expect(results).toEqual([
      {
        info: { fileType: 'image/png' },
        bytes: thumbnail,
        from: expect.objectContaining({ id: kofiLaptop.connection.id }),
      },
    ]);
  });

  it('keeps JSON and binary server requests apart', async () => {
    const results: unknown[] = [];
    const { handle, frames } = await connect(start(huddle(results)));

    await handle.handleMessage(textOf('mix-up-requests', null, null));
    await tick();

    expect(results).toEqual([
      "request-not-declared: [livething] 'capture-screen' is declared in binary({ serverRequests }). Send it with .binary.request(...), not .request(...).",
      "request-not-declared: [livething] 'confirm-leave' is declared in serverRequests({...}). Send it with .request(...), not .binary.request(...).",
    ]);
    expect(frames()).toEqual([]);
  });

  it('works on ctx.channel, with bytes', async () => {
    const results: unknown[] = [];
    const { handle, frames, subscribe } = await connect(start(huddle(results)));
    await subscribe();
    await handle.handleMessage(textOf('share-whiteboard', null, general));
    const request = frames().at(-1)!;

    const { exchange } = request.envelope[2] as { exchange: { id: string } };

    expect(request).toEqual({
      kind: 'bytes',
      envelope: ['capture-whiteboard', null, { exchange, ...general }],
      bytes: [7],
    });

    await handle.handleBinaryMessage(frameOf('capture-whiteboard', null, { exchange, ...general }));
    await tick();

    expect(results).toEqual([{ info: null, bytes: NO_BYTES }]);
  });

  it.each(['__capture-screen', 'capture-screen__'])(
    'refuses the reserved server request name %s when it is declared',
    (name) => {
      expect(() => binary({ serverRequests: { [name]: { out: t<null>() } } })).toThrow();
    },
  );

  it("refuses a server request name with '::' when the engine is built", () => {
    const base = server({
      capabilities: [
        binary({ serverRequests: { 'capture::screen': { out: t<null>() } } }),
        serverRequests(),
      ],
    });

    expect(() => start(base.assemble({ handlers: [] }))).toThrow(/contains '::'/);
  });

  it('needs serverRequests(), and one name for one server request in a scope', () => {
    const noRequests = server({
      capabilities: [binary({ serverRequests: { 'capture-screen': { out: t<null>() } } })],
    });
    expect(() => noRequests.assemble({ handlers: [] })).toThrow(
      /binary\(\{ serverRequests \}\) needs serverRequests\(\)/,
    );

    const both = server({
      capabilities: [
        binary({ serverRequests: { 'capture-screen': { out: t<null>() } } }),
        serverRequests({ 'capture-screen': { out: t<null>() } }),
      ],
    });
    expect(() => both.assemble({ handlers: [] })).toThrow(/duplicate serverRequests\(\)/);

    const channelOnly = server({ capabilities: [binary(), channels()] }) as any;
    expect(() =>
      channelOnly.channel('lobby', {
        capabilities: [binary({ serverRequests: { 'capture-whiteboard': { out: t<null>() } } })],
      }),
    ).toThrow(/serverRequests\(\) is not listed/);
  });
});
