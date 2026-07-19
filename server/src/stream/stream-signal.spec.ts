/* oxlint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';
import { cancelActiveStreamsForConnection, handleShutdown } from '~/_engine/runtime/connection.ts';
import { wrapStreamGenerator } from '~/stream/shared.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { SendThroughPipelineOptions } from '~/outgoing/runtime.ts';
import { cancelStream, runStream } from './runtime.ts';

/**
 * Phase 5 — the stream stop signal. These cover the three fire points (client
 * cancel, owning-connection disconnect, server shutdown), that the signal is
 * exposed on the run ctx as `ctx.stream.signal`, that aborting precedes
 * `generator.return()`, that it is idempotent, and per-stream isolation under
 * `allowConcurrent`.
 */

type AsyncContextStore = { connectionId?: string; [key: PropertyKey]: unknown };

function createConnection(id = 'c1'): RuntimeConnection {
  return {
    id,
    userId: id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      close() {},
      bufferedAmount() {
        return 0;
      },
      identity: id,
    },
    meta: {},
    tags: { ephemeral: new Map<string, Set<string>>(), persistent: new Map<string, Set<string>>() },
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function createStreamRuntime() {
  return {
    activeStreams: new Map(),
    connections: new Map<string, RuntimeConnection>(),
    generateId: () => 'stream_1',
    buildConnectionContext: () => ({ id: 'c1', nudges: () => [] }),
    sendProtocolMessage: (_conn: RuntimeConnection, _opts: SendProtocolMessageOptions) => {},
    sendThroughPipeline: (_conn: RuntimeConnection, _opts: SendThroughPipelineOptions) => true,
    asyncContext: new AsyncLocalStorage<AsyncContextStore>(),
    persistAttachment: vi.fn(),
    wskitStampHooks: [],
    logger: { warn: vi.fn(), error: vi.fn() },
    errorHooks: [] as never[],
    declaredErrorCodes: new Set<string>(),
    async handleRuntimeError() {},
    async handleValidationError() {},
  };
}

/**
 * A stream whose generator captures its `ctx`, records the signal state in its
 * `finally`, and blocks forever after the first yield until the signal aborts —
 * so a test can cancel it mid-flight and inspect what the generator saw.
 */
function blockingStream() {
  const seen: { signal?: AbortSignal; abortedInFinally?: boolean; abortReason?: unknown } = {};
  let aborted = false;
  const stream = {
    stream: { nudges: [], broadcast: false },
    generator: wrapStreamGenerator(async function* (ctx: Record<string, any>) {
      seen.signal = ctx.stream.signal as AbortSignal;
      seen.signal.addEventListener('abort', () => {
        aborted = true;
      });
      try {
        yield { tick: 0 };
        await new Promise<void>((resolve) => {
          if (seen.signal!.aborted) return resolve();
          seen.signal!.addEventListener('abort', () => resolve());
        });
      } finally {
        seen.abortedInFinally = seen.signal?.aborted;
        seen.abortReason = seen.signal?.reason;
      }
    }),
  };
  return { stream, seen, wasAborted: () => aborted };
}

describe('stream stop signal (ctx.stream.signal)', () => {
  it('exposes an AbortSignal on ctx.stream.signal inside the generator', async () => {
    const runtime = createStreamRuntime();
    const connection = createConnection();
    const { stream, seen } = blockingStream();

    const run = runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'feed',
      stream: stream as never,
      payload: {},
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.signal!.aborted).toBe(false);

    await cancelStream(runtime as Parameters<typeof cancelStream>[0], connection, 'stream_1');
    await run;
  });

  it('fires the signal on a client __streamCancel__ (cancelStream)', async () => {
    const runtime = createStreamRuntime();
    const connection = createConnection();
    const { stream, seen, wasAborted } = blockingStream();

    const run = runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'feed',
      stream: stream as never,
      payload: {},
    });
    await Promise.resolve();
    await Promise.resolve();

    await cancelStream(runtime as Parameters<typeof cancelStream>[0], connection, 'stream_1');
    await run;

    expect(wasAborted()).toBe(true);
    // Abort happened before the generator's finally ran (precedence guarantee).
    expect(seen.abortedInFinally).toBe(true);
    expect(seen.abortReason).toBe('cancelled');
    expect(runtime.activeStreams.has('stream_1')).toBe(false);
  });

  it('fires the signal when the owning connection disconnects', async () => {
    const runtime = createStreamRuntime();
    const connection = createConnection();
    const { stream, seen, wasAborted } = blockingStream();

    const run = runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'feed',
      stream: stream as never,
      payload: {},
    });
    await Promise.resolve();
    await Promise.resolve();

    await cancelActiveStreamsForConnection(
      runtime as Parameters<typeof cancelActiveStreamsForConnection>[0],
      connection.id,
    );
    await run;

    expect(wasAborted()).toBe(true);
    expect(seen.abortedInFinally).toBe(true);
    expect(seen.abortReason).toBe('aborted');
  });

  it('fires the signal on server shutdown — including a detached keep-running stream', async () => {
    const runtime = createStreamRuntime();
    const connection = createConnection();
    runtime.connections.set(connection.id, connection);

    // A keep-running stream: a plain disconnect would detach (not abort) it, but
    // shutdown must still fire its signal.
    const { stream, seen } = blockingStream();
    (stream.stream as Record<string, unknown>).broadcast = true;
    const run = runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'feed',
      stream: stream as never,
      payload: {},
    });
    await Promise.resolve();
    await Promise.resolve();
    runtime.activeStreams.get('stream_1')!.onDisconnect = 'keep-running';

    await handleShutdown({
      connections: runtime.connections,
      activeStreams: runtime.activeStreams,
      shutdownHooks: [],
      createShutdownContext: () => ({}),
      cancelActiveStreamsForConnection: () => Promise.resolve(),
      handleConnectionClose: () => Promise.resolve(),
      alarmState: { current: null },
      logger: runtime.logger,
    } as Parameters<typeof handleShutdown>[0]);

    expect(seen.signal!.aborted).toBe(true);
    expect(seen.signal!.reason).toBe('shutdown');

    await cancelStream(runtime as Parameters<typeof cancelStream>[0], connection, 'stream_1');
    await run;
  });

  it('aborting is idempotent — a cancel after disconnect keeps the first reason', async () => {
    const runtime = createStreamRuntime();
    const connection = createConnection();
    const { stream } = blockingStream();

    const run = runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'feed',
      stream: stream as never,
      payload: {},
    });
    await Promise.resolve();
    await Promise.resolve();

    const active = runtime.activeStreams.get('stream_1')!;
    await cancelActiveStreamsForConnection(
      runtime as Parameters<typeof cancelActiveStreamsForConnection>[0],
      connection.id,
    );
    const firstReason = active.abortController.signal.reason;
    // A late cancel must not re-abort with a different reason.
    await cancelStream(runtime as Parameters<typeof cancelStream>[0], connection, 'stream_1');
    expect(active.abortController.signal.reason).toBe(firstReason);
    await run;
  });

  it('gives each concurrent stream its own signal (per-stream isolation)', async () => {
    const runtime = createStreamRuntime();
    const connection = createConnection();
    let nextId = 0;
    runtime.generateId = () => `stream_${++nextId}`;

    const a = blockingStream();
    (a.stream.stream as Record<string, unknown>).allowConcurrent = true;
    const b = blockingStream();
    (b.stream.stream as Record<string, unknown>).allowConcurrent = true;

    const runA = runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'feed-a',
      stream: a.stream as never,
      payload: {},
    });
    const runB = runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'feed-b',
      stream: b.stream as never,
      payload: {},
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(a.seen.signal).not.toBe(b.seen.signal);

    await cancelStream(runtime as Parameters<typeof cancelStream>[0], connection, 'stream_1');
    expect(a.seen.signal!.aborted).toBe(true);
    expect(b.seen.signal!.aborted).toBe(false);

    await cancelStream(runtime as Parameters<typeof cancelStream>[0], connection, 'stream_2');
    await Promise.all([runA, runB]);
  });

  it('a normally completing stream leaves its signal unaborted', async () => {
    const runtime = createStreamRuntime();
    const connection = createConnection();
    let captured: AbortSignal | undefined;
    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: wrapStreamGenerator(async function* (ctx: Record<string, any>) {
        captured = ctx.stream.signal as AbortSignal;
        yield { done: true };
      }),
    };

    await runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'feed',
      stream: stream as never,
      payload: {},
    });

    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);
  });

  // Keeps the valibot import meaningful for the harness shape used above.
  it('signal handle is independent of declared nudges', async () => {
    const runtime = createStreamRuntime();
    const connection = createConnection();
    let captured: AbortSignal | undefined;
    const stream = {
      stream: {
        nudges: [{ event: 'cancel', validator: v.optional(v.unknown()) }],
        broadcast: false,
      },
      generator: wrapStreamGenerator(async function* (ctx: Record<string, any>) {
        captured = ctx.stream.signal as AbortSignal;
        expect(typeof ctx.stream.nudges).toBe('function');
        yield { done: true };
      }),
    };

    await runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'feed',
      stream: stream as never,
      payload: {},
    });

    expect(captured).toBeInstanceOf(AbortSignal);
  });
});
