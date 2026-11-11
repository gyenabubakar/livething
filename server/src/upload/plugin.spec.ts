/* oxlint-disable @typescript-eslint/no-explicit-any */
// Uploads in a plugin: the plugin lists `uploads()` and declares `binary.upload`. Its upload
// lives under `__<id>::<name>`, its `run` and `onDiscard` run as the plugin, and its errors
// keep their plugin codes. The host and the plugin share one upload engine.
import { AsyncLocalStorage } from 'node:async_hooks';
import { encodeBinaryFrame, LiveThingConfigError, splitBinaryFrame } from '@livething/core';
import { adapter } from '~/_adapters/adapter.ts';
import { plugin } from '~/_define/plugins.ts';
import { server } from '~/_define/server.ts';
import { createTestKV, createTestSql } from '~/_test/sql.ts';
import { createTestTimers } from '~/_test/timers.ts';
import { binary } from '~/binary/capability.ts';
import { errors } from '~/errors/capability.ts';
import { error } from '~/errors/errors.ts';
import { uploads } from '~/upload/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import type { TransportFrame } from '~/_adapters/types.ts';
import type { Engine } from '~/_engine/engine.ts';
import type { ServerDefinition } from '~/server-definition.ts';
import type { UploadsOptions } from '~/upload/capability.ts';

const FilesFull = error('files-full');
const WIRE = '__acme:files::store-file';
const NO_BYTES = new Uint8Array(0);

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Seen {
  /** What each run read, and the plugin it ran as. */
  runs: { bytes: number[]; scoped: boolean }[];
  /** Each `onDiscard`'s input. Whether it ran as the plugin is read from the kv key it wrote. */
  discarded: { input: unknown; scoped: boolean }[];
  /** The checked `ctx.upload.state` each run and each `onDiscard` got. */
  states: unknown[];
}

function filesPlugin(seen: Seen, pluginUploads: UploadsOptions = {}) {
  const files = server({
    scope: 'plugin',
    capabilities: [binary(), uploads(pluginUploads), errors([FilesFull])],
  });
  const handleStoreFile = files.binary.upload('store-file', {
    input: v.object({ fileId: v.string(), full: v.optional(v.boolean()) }),
    pieceBytes: 8,
    windowBytes: 16,
    state: v.pipe(
      v.object({ storedBytes: v.number() }),
      v.transform((state) => ({ ...state, checked: true })),
    ),
    async run(ctx, input, pieces) {
      seen.states.push(ctx.upload.state);
      const bytes: number[] = [];
      // A plugin's scoped ctx names its own events: `send` would add the `__acme:files::` prefix.
      seen.runs.push({ bytes, scoped: typeof (ctx as any).plugin === 'function' });
      for await (const piece of pieces) {
        if (input.full) throw FilesFull();

        bytes.push(...piece.bytes);
        const storedBytes = piece.offset + piece.bytes.byteLength;
        ctx.upload.saved(storedBytes, { state: { storedBytes } });
      }

      return { info: { size: bytes.length } };
    },
    async onDiscard(ctx, input) {
      seen.states.push(ctx.upload.state);
      // As the plugin, this key is stored as `__acme:files::discarded`.
      await ctx.kv.set('discarded', input.fileId);
      seen.discarded.push({ input, scoped: true });
    },
  });

  return plugin('acme:files', { definition: files.assemble({ handlers: [handleStoreFile] }) });
}

function start(definition: ServerDefinition): Engine {
  let engine!: Engine;
  adapter({
    id: 'upload-plugin-spec',
    asyncContextFactory: <TStore>() => new AsyncLocalStorage<TStore>(),
    setup(createEngine) {
      engine = createEngine({
        storage: { sql: createTestSql(), kv: createTestKV() },
        timers: createTestTimers(),
        platform: {},
        logger: { info() {}, warn() {}, error() {} },
      });
      return {};
    },
  })(definition, undefined as never);
  return engine;
}

function host(seen: Seen, options: { host?: UploadsOptions; plugin?: UploadsOptions } = {}) {
  const base = server({
    capabilities: [binary(), uploads(options.host), filesPlugin(seen, options.plugin)()],
  });
  return start(base.assemble({ handlers: [] }));
}

async function connect(engine: Engine) {
  await engine.initialize();
  const sent: TransportFrame[] = [];
  const handle = engine.accept(Symbol('u_amara'), {
    send: (data: TransportFrame) => sent.push(data),
    close: () => {},
    bufferedAmount: () => 0,
    userId: 'u_amara',
  });
  await [...engine.core.connections.values()].at(-1)!.lifecycleReady;

  function binaryFrame(envelope: unknown[], bytes: Uint8Array = NO_BYTES) {
    return handle.handleBinaryMessage(encodeBinaryFrame(JSON.stringify(envelope), bytes));
  }

  return {
    frames: (): any[][] =>
      sent.map((data) => {
        if (data.kind === 'text') return JSON.parse(data.text);

        const split = splitBinaryFrame(data.bytes);
        return split.kind === 'frame' ? JSON.parse(split.envelope) : [];
      }),
    start: (event: string, input: unknown) =>
      binaryFrame([event, input, { upload: { id: 'up-1' } }]),
    piece: (seq: number, bytes: Uint8Array) =>
      binaryFrame([WIRE, null, { upload: { id: 'up-1', seq } }], bytes),
    end: (totalBytes: number) =>
      handle.handleMessage(
        JSON.stringify(['__uploadEnd__', { totalBytes }, { upload: { id: 'up-1' } }]),
      ),
    cancel: () =>
      handle.handleMessage(JSON.stringify(['__uploadCancel__', null, { upload: { id: 'up-1' } }])),
    close: () => handle.handleClose(1006, 'dropped'),
  };
}

function emptySeen(): Seen {
  return { runs: [], discarded: [], states: [] };
}

describe('uploads in a plugin', () => {
  it('runs the upload under its __<id>:: name, as the plugin, and replies', async () => {
    const seen = emptySeen();
    const amara = await connect(host(seen));
    await amara.start(WIRE, { fileId: 'f1' });
    await amara.piece(1, new Uint8Array([1, 2, 3, 4]));
    await amara.end(4);

    await settle();

    expect(seen.runs).toEqual([{ bytes: [1, 2, 3, 4], scoped: true }]);
    expect(amara.frames().at(-1)).toEqual([
      '__uploadDone__',
      { info: { size: 4 } },
      { upload: { id: 'up-1' } },
    ]);
  });

  it("checks the plugin's stored state with its schema on a resume and before onDiscard", async () => {
    const seen = emptySeen();
    const engine = host(seen);
    const first = await connect(engine);
    await first.start(WIRE, { fileId: 'f1' });
    await first.piece(1, new Uint8Array([1, 2, 3]));

    await settle();
    await first.close();
    await settle();

    const second = await connect(engine);
    await second.start(WIRE, { fileId: 'f1' });
    await settle();
    await second.cancel();
    await settle();

    expect(seen.states).toEqual([
      undefined,
      { storedBytes: 3, checked: true },
      { storedBytes: 3, checked: true },
    ]);
  });

  it('does not take the bare name: only the __<id>:: name is the upload', async () => {
    const seen = emptySeen();
    const amara = await connect(host(seen));
    await amara.start('store-file', { fileId: 'f1' });
    await settle();

    expect(seen.runs).toEqual([]);
  });

  it("sends the plugin's declared error with its __<id>:: code, and runs onDiscard as the plugin", async () => {
    const seen = emptySeen();
    const engine = host(seen);
    const amara = await connect(engine);
    await amara.start(WIRE, { fileId: 'f1', full: true });
    await amara.piece(1, new Uint8Array([1]));

    await settle();

    expect(amara.frames().at(-1)).toEqual([
      '__error__',
      { code: '__acme:files::files-full' },
      { upload: { id: 'up-1' } },
    ]);
    expect(seen.discarded).toEqual([{ input: { fileId: 'f1', full: true }, scoped: true }]);
    expect(await engine.core.storage.kv.get('__acme:files::discarded')).toBe('f1');
  });

  it("runs the plugin's onDiscard, as the plugin, when its upload expires", async () => {
    const seen = emptySeen();
    const engine = host(seen, { host: { expireAfterMs: 20 } });
    const amara = await connect(engine);
    await amara.start(WIRE, { fileId: 'f1' });
    await amara.piece(1, new Uint8Array([1]));

    await settle();
    await amara.close();
    await settle();

    await new Promise((resolve) => setTimeout(resolve, 40));
    await engine.handleAlarm();
    await settle();
    expect(seen.discarded).toEqual([{ input: { fileId: 'f1' }, scoped: true }]);
    expect(await engine.core.storage.kv.get('__acme:files::discarded')).toBe('f1');
  });

  it("uses the host's times when only the host sets them, and refuses two different settings", async () => {
    const seen = emptySeen();
    const engine = host(seen, { host: { expireAfterMs: 20 } });
    await engine.initialize();

    const conflicting = host(emptySeen(), {
      host: { expireAfterMs: 20 },
      plugin: { expireAfterMs: 50 },
    });
    await expect(conflicting.initialize()).rejects.toThrow(LiveThingConfigError);

    const same = host(emptySeen(), {
      host: { expireAfterMs: 20 },
      plugin: { expireAfterMs: 20 },
    });
    await expect(same.initialize()).resolves.toBeUndefined();

    // Each sets a different time: no conflict.
    const split = host(emptySeen(), {
      host: { expireAfterMs: 20 },
      plugin: { retentionAfterDoneMs: 5_000 },
    });
    await expect(split.initialize()).resolves.toBeUndefined();
  });

  it('applies both times when the host sets one and the plugin the other', async () => {
    const seen = emptySeen();
    const engine = host(seen, {
      host: { expireAfterMs: 20 },
      plugin: { retentionAfterDoneMs: 20 },
    });
    const amara = await connect(engine);

    // The plugin's retention: the done reply is gone after 20 ms, so a new start runs again.
    await amara.start(WIRE, { fileId: 'f1' });
    await amara.piece(1, new Uint8Array([1]));
    await amara.end(1);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 40));

    await engine.handleAlarm();
    await amara.start(WIRE, { fileId: 'f1' });
    await settle();
    expect(seen.runs).toHaveLength(2);

    // The host's expiry: the second, idle upload is discarded after 20 ms.
    await amara.close();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await engine.handleAlarm();
    await settle();

    expect(seen.discarded).toEqual([{ input: { fileId: 'f1' }, scoped: true }]);
  });

  it('expires a plugin upload with the time a plugin-only uploads(...) set', async () => {
    const seen = emptySeen();
    const engine = host(seen, { plugin: { expireAfterMs: 20 } });
    const amara = await connect(engine);
    await amara.start(WIRE, { fileId: 'f1' });
    await amara.piece(1, new Uint8Array([1]));

    await settle();
    await amara.close();
    await settle();

    await new Promise((resolve) => setTimeout(resolve, 40));
    await engine.handleAlarm();
    await settle();
    expect(seen.discarded).toEqual([{ input: { fileId: 'f1' }, scoped: true }]);
  });
});
