import { AsyncLocalStorage } from 'node:async_hooks';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveStream, RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type {
  BroadcastToConnectionsOptions,
  SendThroughPipelineOptions,
} from '~/outgoing/runtime.ts';
import { bufferStreamNudge, cancelStream, runStream } from './runtime.ts';
import type { RunStreamOptions } from './runtime.ts';

type AsyncContextStore = {
  connectionId?: string;
  [key: PropertyKey]: unknown;
};

function createConnection(id = 'c1'): RuntimeConnection {
  return {
    id,
    identity: id,
    wsKey: Symbol(id),
    descriptor: {
      send: vi.fn(),
      sendBinary() {},
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
  const protocolMessages: {
    event: string;
    payload: Record<string, unknown>;
    wskit: Record<string, unknown>;
  }[] = [];
  const pipelineSends: { event: string; payload: unknown }[] = [];
  const broadcasts: {
    event: string;
    payload: unknown;
    options?: { namespace?: string; channel?: string; excludeSelf?: boolean };
    excludeConnectionId?: string;
    targetIds: string[];
  }[] = [];

  return {
    protocolMessages,
    pipelineSends,
    broadcasts,
    runtime: {
      activeStreams: new Map(),
      connections: new Map<string, RuntimeConnection>(),
      generateId: () => 'stream_1',
      buildConnectionContext: () => ({ id: 'c1', nudges: () => [] }),
      sendProtocolMessage: (
        _conn: RuntimeConnection,
        { event, payload, wskit }: SendProtocolMessageOptions,
      ) => {
        protocolMessages.push({ event, payload, wskit });
      },
      sendThroughPipeline: (
        _conn: RuntimeConnection,
        { event, payload }: SendThroughPipelineOptions,
      ) => {
        pipelineSends.push({ event, payload });
        return true;
      },
      broadcastToConnections: (
        conns: readonly RuntimeConnection[],
        { event, payload, options, excludeConnectionId }: BroadcastToConnectionsOptions,
      ) => {
        broadcasts.push({
          event,
          payload,
          options,
          excludeConnectionId,
          targetIds: conns.map((c) => c.id),
        });
      },
      asyncContext: new AsyncLocalStorage<AsyncContextStore>(),
      persistAttachment: vi.fn(),
      wskitStampHooks: [],
      logger: { warn: vi.fn(), error: vi.fn() },
      errorHooks: [] as readonly ((
        ctx: unknown,
        error: unknown,
        event?: string,
      ) => void | Promise<void>)[],
      async handleRuntimeError() {},
      async handleValidationError() {},
    },
  };
}

describe('stream/runtime', () => {
  it('__streamEnd__ includes namespace routing metadata', async () => {
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: { namespace: { name: 'ai' } as never },
      event: 'stream-prompt',
      stream: stream as never,
      payload: {},
    });

    const streamEnd = protocolMessages.find((m) => m.event === '__streamEnd__');
    expect(streamEnd).toBeDefined();
    expect(streamEnd!.wskit.namespace).toBe('ai');
  });

  it('__streamEnd__ includes channel routing metadata', async () => {
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: { channelName: 'chat', channelScope: 'rooms' },
      event: 'chat-stream',
      stream: stream as never,
      payload: {},
    });

    const streamEnd = protocolMessages.find((m) => m.event === '__streamEnd__');
    expect(streamEnd).toBeDefined();
    expect(streamEnd!.wskit.channel).toBe('chat');
    expect(streamEnd!.wskit.channelScope).toBe('rooms');
  });

  it('broadcast stream sends chunks to all connections', async () => {
    const { runtime, broadcasts, pipelineSends } = createStreamRuntime();
    const trigger = createConnection('trigger');
    const other = createConnection('other');
    runtime.connections.set(trigger.id, trigger);
    runtime.connections.set(other.id, other);

    const stream = {
      stream: { nudges: [], broadcast: true },
      generator: async function* () {
        yield { token: 'hello' };
      },
    };

    await runStream(runtime as Parameters<typeof runStream>[0], trigger, {
      scope: {},
      event: 'broadcast-stream',
      stream: stream as never,
      payload: {},
    });

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.event).toBe('broadcast-stream');
    expect(broadcasts[0]!.options?.excludeSelf).toBe(true);
    expect(broadcasts[0]!.excludeConnectionId).toBe('trigger');
    expect(pipelineSends).toHaveLength(1);
    expect(pipelineSends[0]!.event).toBe('broadcast-stream');
  });

  it('broadcast stream forwards channelScope to peer sends (dynamic channel families)', async () => {
    const { runtime, broadcasts, pipelineSends } = createStreamRuntime();
    const trigger = createConnection('trigger');
    const peer = createConnection('peer');
    // Both are members of the channel family scope.
    trigger.channelMemberships.set(createChannelMembershipKey('room:123', 'rooms'), {
      channelName: 'room:123',
      channelScope: 'rooms',
    });
    peer.channelMemberships.set(createChannelMembershipKey('room:123', 'rooms'), {
      channelName: 'room:123',
      channelScope: 'rooms',
    });
    runtime.connections.set(trigger.id, trigger);
    runtime.connections.set(peer.id, peer);

    const stream = {
      stream: { nudges: [], broadcast: true },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    // Stream declared inside `channel(scope('rooms', /^room:.+$/))`. The
    // active scope carries channelName: 'room:123' and channelScope: 'rooms'.
    // Peer broadcasts must forward channelScope so the outgoing pipeline
    // resolves the channel family rather than failing the declaration check
    // against a non-existent static channel called 'room:123'.
    await runStream(runtime as Parameters<typeof runStream>[0], trigger, {
      scope: { channelName: 'room:123', channelScope: 'rooms' },
      event: 'broadcast-stream',
      stream: stream as never,
      payload: {},
    });

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.options?.channel).toBe('room:123');
    expect((broadcasts[0]!.options as { channelScope?: string })?.channelScope).toBe('rooms');

    // The trigger's own send should also carry channelScope for symmetry.
    expect(pipelineSends).toHaveLength(1);
  });

  it('channel-scoped broadcast stream excludes non-members from the targets list', async () => {
    const { runtime, broadcasts } = createStreamRuntime();
    const trigger = createConnection('trigger');
    const member = createConnection('member');
    const nonMember = createConnection('non-member');

    trigger.channelMemberships.set(createChannelMembershipKey('room:1', 'rooms'), {
      channelName: 'room:1',
      channelScope: 'rooms',
    });
    member.channelMemberships.set(createChannelMembershipKey('room:1', 'rooms'), {
      channelName: 'room:1',
      channelScope: 'rooms',
    });
    // nonMember is connected but never subscribed.

    runtime.connections.set(trigger.id, trigger);
    runtime.connections.set(member.id, member);
    runtime.connections.set(nonMember.id, nonMember);

    const stream = {
      stream: { nudges: [], broadcast: true },
      generator: async function* () {
        yield { token: 'private' };
      },
    };

    await runStream(runtime as Parameters<typeof runStream>[0], trigger, {
      scope: { channelName: 'room:1', channelScope: 'rooms' },
      event: 'broadcast-stream',
      stream: stream as never,
      payload: {},
    });

    expect(broadcasts).toHaveLength(1);
    // The targets list passed to broadcastToConnections must only contain
    // members of the channel — never the non-member.
    expect(broadcasts[0]!.targetIds).toEqual(expect.arrayContaining(['trigger', 'member']));
    expect(broadcasts[0]!.targetIds).not.toContain('non-member');
  });

  it('top-level broadcast stream still targets every connection (no membership concept)', async () => {
    const { runtime, broadcasts } = createStreamRuntime();
    const trigger = createConnection('trigger');
    const other = createConnection('other');
    runtime.connections.set(trigger.id, trigger);
    runtime.connections.set(other.id, other);

    const stream = {
      stream: { nudges: [], broadcast: true },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await runStream(runtime as Parameters<typeof runStream>[0], trigger, {
      scope: {},
      event: 'broadcast-stream', // no channelName — top-level broadcast
      stream: stream as never,
      payload: {},
    });

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.targetIds).toEqual(expect.arrayContaining(['trigger', 'other']));
  });

  it('__streamCancel__ from a non-owner connection is ignored', async () => {
    const owner = createConnection('owner');
    const stranger = createConnection('stranger');

    const generator = {
      return: vi.fn(async () => ({ done: true, value: undefined })),
      next: vi.fn(),
      throw: vi.fn(),
      [Symbol.asyncIterator]() {
        return this;
      },
    } as unknown as AsyncGenerator<unknown, void, unknown>;

    const activeStreams = new Map<string, ActiveStream>();
    const streamId = 'stream_owned_by_owner';
    activeStreams.set(streamId, {
      id: streamId,
      connectionId: owner.id,
      event: 'owned-stream',
      generator,
      nudges: [],
      nudgeValidators: new Map(),
      closed: false,
    });

    await cancelStream({ activeStreams }, stranger, streamId);

    expect(generator.return as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(activeStreams.has(streamId)).toBe(true);
    expect(activeStreams.get(streamId)?.closed).toBe(false);
  });

  it('cancelStream catches and logs when the generator finally throws', async () => {
    // Pre-fix the throw escaped through processTextMessage into the
    // adapter WS message callback as an unhandled adapter error. The
    // engine must contain it, log it, and complete the cleanup.
    const owner = createConnection('owner');
    const generator = (async function* () {
      try {
        yield 1;
      } finally {
        // oxlint-disable-next-line no-unsafe-finally
        throw new Error('user finally threw');
      }
    })();
    await generator.next(); // park at the yield so .return() hits the finally

    const activeStreams = new Map<string, ActiveStream>();
    activeStreams.set('stream_1', {
      id: 'stream_1',
      connectionId: owner.id,
      event: 'finally-throws-stream',
      generator: generator as AsyncGenerator<unknown, void, unknown>,
      nudges: [],
      nudgeValidators: new Map(),
      closed: false,
    });
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

    await expect(
      cancelStream({ activeStreams, logger }, owner, 'stream_1'),
    ).resolves.toBeUndefined();

    expect(activeStreams.has('stream_1')).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, fields] = logger.error.mock.calls[0]!;
    expect(message).toMatch(/stream cleanup threw on __streamCancel__/);
    expect((fields as { streamId?: string }).streamId).toBe('stream_1');
  });

  it('non-broadcast stream does not call broadcastToConnections', async () => {
    const { runtime, broadcasts } = createStreamRuntime();
    const connection = createConnection();

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'my-stream',
      stream: stream as never,
      payload: {},
    });

    expect(broadcasts).toHaveLength(0);
  });

  it('Defer thrown from a stream handler logs an error, fires onError hooks, and sends __error__ with internal-error code', async () => {
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();
    const handleRuntimeError = vi.fn();
    runtime.handleRuntimeError = handleRuntimeError;

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        throw Object.freeze({ __wskit: 'defer' as const, delay: 500 });
        yield; // make it a generator
      },
    };

    await runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'stream-event',
      stream: stream as never,
      payload: {},
    });

    expect(handleRuntimeError).not.toHaveBeenCalled();
    expect((runtime.logger.error as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatch(/Defer/);
    const errMsg = protocolMessages.find((m) => m.event === '__error__');
    expect(errMsg).toBeDefined();
    expect(errMsg!.payload.code).toBe('internal-error');
    expect(errMsg!.wskit.streamId).toBe('stream_1');
  });

  it('bufferStreamNudge surfaces __error__ and returns true for an unknown streamId', async () => {
    // A frame carrying `streamId` is claiming to belong to one specific
    // stream. If the id is unknown, the frame is malformed — surface
    // `__error__` with `streamId` routing and treat it as handled so it
    // never falls through to a same-named top-level .incoming() handler.
    const { runtime } = createStreamRuntime();
    const connection = createConnection();
    const handleRuntimeError = vi.fn();
    runtime.handleRuntimeError = handleRuntimeError;

    const result = await bufferStreamNudge(
      runtime as Parameters<typeof bufferStreamNudge>[0],
      connection,
      {
        event: 'nudge-event',
        payload: {},
        wskit: { streamId: 'does-not-exist', channelScope: null },
      },
    );

    expect(result).toBe(true);
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    expect(handleRuntimeError).toHaveBeenCalledWith(connection, {
      error: expect.any(Error),
      event: 'nudge-event',
      routing: { streamId: 'does-not-exist' },
    });
  });

  it('bufferStreamNudge surfaces __error__ and returns true for a closed stream', async () => {
    const { runtime } = createStreamRuntime();
    const connection = createConnection();
    const handleRuntimeError = vi.fn();
    runtime.handleRuntimeError = handleRuntimeError;

    const closed: ActiveStream = {
      id: 'stream_1',
      connectionId: connection.id,
      event: 'closed-stream',
      generator: (async function* () {})() as AsyncGenerator<unknown, void, unknown>,
      nudges: [],
      nudgeValidators: new Map([['known-nudge', undefined]]),
      closed: true,
    };
    runtime.activeStreams.set('stream_1', closed);

    const result = await bufferStreamNudge(
      runtime as Parameters<typeof bufferStreamNudge>[0],
      connection,
      { event: 'known-nudge', payload: {}, wskit: { streamId: 'stream_1', channelScope: null } },
    );

    expect(result).toBe(true);
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
  });

  it('bufferStreamNudge surfaces __error__ and returns true for a stream owned by a different connection', async () => {
    const { runtime } = createStreamRuntime();
    const owner = createConnection('owner');
    const intruder = createConnection('intruder');
    const handleRuntimeError = vi.fn();
    runtime.handleRuntimeError = handleRuntimeError;

    runtime.activeStreams.set('stream_1', {
      id: 'stream_1',
      connectionId: owner.id,
      generator: (async function* () {})() as AsyncGenerator<unknown, void, unknown>,
      nudges: [],
      nudgeValidators: new Map([['known-nudge', undefined]]),
      closed: false,
    });

    const result = await bufferStreamNudge(
      runtime as Parameters<typeof bufferStreamNudge>[0],
      intruder,
      { event: 'known-nudge', payload: {}, wskit: { streamId: 'stream_1', channelScope: null } },
    );

    expect(result).toBe(true);
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
  });

  it('bufferStreamNudge appends while under the buffer cap', async () => {
    const { runtime } = createStreamRuntime();
    const connection = createConnection();

    const active: ActiveStream = {
      id: 'stream_1',
      connectionId: connection.id,
      event: 'nudgey',
      generator: (async function* () {})() as AsyncGenerator<unknown, void, unknown>,
      nudges: new Array(255).fill({ event: 'n', payload: {} }),
      nudgeValidators: new Map([['n', undefined]]),
      closed: false,
    };
    runtime.activeStreams.set('stream_1', active);

    const result = await bufferStreamNudge(
      runtime as Parameters<typeof bufferStreamNudge>[0],
      connection,
      { event: 'n', payload: { k: 1 }, wskit: { streamId: 'stream_1', channelScope: null } },
    );

    expect(result).toBe(true);
    expect(active.nudges).toHaveLength(256);
    expect(active.closed).toBe(false);
    expect(runtime.activeStreams.has('stream_1')).toBe(true);
  });

  it('bufferStreamNudge aborts the stream when the buffer is full', async () => {
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();

    const active: ActiveStream = {
      id: 'stream_1',
      connectionId: connection.id,
      event: 'nudgey',
      generator: (async function* () {})() as AsyncGenerator<unknown, void, unknown>,
      // Already at the 256 cap.
      nudges: new Array(256).fill({ event: 'n', payload: {} }),
      nudgeValidators: new Map([['n', undefined]]),
      closed: false,
    };
    runtime.activeStreams.set('stream_1', active);

    const result = await bufferStreamNudge(
      runtime as Parameters<typeof bufferStreamNudge>[0],
      connection,
      { event: 'n', payload: { k: 1 }, wskit: { streamId: 'stream_1', channelScope: null } },
    );

    expect(result).toBe(true);
    // Stream torn down.
    expect(active.closed).toBe(true);
    expect(runtime.activeStreams.has('stream_1')).toBe(false);
    // Client told the stream was aborted for nudge overflow.
    const aborted = protocolMessages.find((m) => m.event === '__error__');
    expect(aborted).toBeDefined();
    expect(aborted!.payload).toMatchObject({
      code: 'stream-aborted',
      detail: { reason: 'nudge-overflow' },
    });
    expect(aborted!.wskit).toMatchObject({ streamId: 'stream_1' });
  });

  it('bufferStreamNudge surfaces __error__ and returns true for an unknown event name on an active stream', async () => {
    const { runtime } = createStreamRuntime();
    const connection = createConnection();
    const handleRuntimeError = vi.fn();
    runtime.handleRuntimeError = handleRuntimeError;

    const activeStream: ActiveStream = {
      id: 'stream_1',
      connectionId: connection.id,
      event: 'known-stream',
      generator: (async function* () {})() as AsyncGenerator<unknown, void, unknown>,
      nudges: [],
      nudgeValidators: new Map([['known-nudge', undefined]]),
      closed: false,
    };
    runtime.activeStreams.set('stream_1', activeStream);

    const result = await bufferStreamNudge(
      runtime as Parameters<typeof bufferStreamNudge>[0],
      connection,
      { event: 'unknown-nudge', payload: {}, wskit: { streamId: 'stream_1', channelScope: null } },
    );

    expect(result).toBe(true);
    expect(activeStream.nudges).toHaveLength(0);
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    expect(handleRuntimeError).toHaveBeenCalledWith(connection, {
      error: expect.any(Error),
      event: 'unknown-nudge',
      routing: { streamId: 'stream_1' },
    });
  });

  it('bufferStreamNudge returns false when the frame carries no streamId at all', async () => {
    // Frames without `streamId` do not claim to belong to any stream.
    // The stream layer steps aside and lets the engine route them as
    // top-level events.
    const { runtime } = createStreamRuntime();
    const connection = createConnection();

    const result = await bufferStreamNudge(
      runtime as Parameters<typeof bufferStreamNudge>[0],
      connection,
      { event: 'plain-event', payload: { value: 'no-stream-id' }, wskit: undefined },
    );

    expect(result).toBe(false);
  });

  it('bufferStreamNudge throws WSKitConfigError without routing through handleValidationError when the nudge validator is async', async () => {
    const { runtime } = createStreamRuntime();
    const connection = createConnection();
    const handleValidationError = vi.fn();
    runtime.handleValidationError = handleValidationError;

    const activeStream: ActiveStream = {
      id: 'stream_1',
      connectionId: connection.id,
      event: 'async-stream',
      generator: (async function* () {})() as AsyncGenerator<unknown, void, unknown>,
      nudges: [],
      nudgeValidators: new Map([['async-nudge', v.objectAsync({})]]),
      closed: false,
    };
    runtime.activeStreams.set('stream_1', activeStream);

    await expect(
      bufferStreamNudge(runtime as Parameters<typeof bufferStreamNudge>[0], connection, {
        event: 'async-nudge',
        payload: {},
        wskit: { streamId: 'stream_1', channelScope: null },
      }),
    ).rejects.toThrow(/async validators are not supported/);

    expect(handleValidationError).not.toHaveBeenCalled();
    expect(activeStream.nudges).toHaveLength(0);
  });

  it('bufferStreamNudge returns true after a sync validation failure (handled with error)', async () => {
    // A frame that matched an active stream and a registered nudge event
    // belongs to the stream. If the nudge validator rejects, the engine
    // routes the validation error AND must signal "handled" so the caller
    // does not fall through to dispatchIncoming — which would otherwise
    // re-route the malformed nudge through any same-named top-level
    // .incoming() handler.
    const { runtime } = createStreamRuntime();
    const connection = createConnection();
    const handleValidationError = vi.fn();
    runtime.handleValidationError = handleValidationError;

    const activeStream: ActiveStream = {
      id: 'stream_1',
      connectionId: connection.id,
      event: 'pause-stream',
      generator: (async function* () {})() as AsyncGenerator<unknown, void, unknown>,
      nudges: [],
      // Schema rejects any payload where `bad` is not literally false.
      nudgeValidators: new Map([['pause', v.object({ bad: v.literal(false) })]]),
      closed: false,
    };
    runtime.activeStreams.set('stream_1', activeStream);

    const handleRuntimeError = vi.fn();
    runtime.handleRuntimeError = handleRuntimeError;

    const result = await bufferStreamNudge(
      runtime as Parameters<typeof bufferStreamNudge>[0],
      connection,
      {
        event: 'pause',
        payload: { bad: true },
        wskit: { streamId: 'stream_1', channelScope: null },
      },
    );

    expect(result).toBe(true);
    expect(handleValidationError).toHaveBeenCalledTimes(1);
    expect(handleValidationError).toHaveBeenCalledWith(connection, {
      event: 'pause',
      validationError: expect.any(Error),
    });
    // The wire `__error__` must reach the client with `streamId` routing so the
    // client can correlate the failure to the right stream-error handler.
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    expect(handleRuntimeError).toHaveBeenCalledWith(connection, {
      error: expect.any(Error),
      event: 'pause',
      routing: { streamId: 'stream_1' },
    });
    expect(activeStream.nudges).toHaveLength(0);
  });

  it('persistAttachment is called with stream ID added on start and removed on end', async () => {
    const { runtime } = createStreamRuntime();
    const connection = createConnection();
    const snapshots: string[][] = [];

    (runtime.persistAttachment as ReturnType<typeof vi.fn>).mockImplementation(() => {
      snapshots.push([...(connection.activeStreamIds ?? [])]);
    });

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'my-stream',
      stream: stream as never,
      payload: {},
    });

    // First call: stream ID was added to activeStreamIds before yield
    expect(snapshots[0]).toContain('stream_1');
    // Last call: stream ID was removed from activeStreamIds in finally
    expect(snapshots[snapshots.length - 1]).not.toContain('stream_1');
    expect(connection.activeStreamIds?.has('stream_1')).toBe(false);
  });

  it('generator body sees the stream owner connection id via the async context', async () => {
    // The engine advances the generator inside `asyncContext.run(...)`, so
    // plugin APIs the generator body calls (e.g. hooks.getState()) resolve to
    // the stream owner instead of `undefined`.
    const { runtime } = createStreamRuntime();
    const connection = createConnection();

    const idsObservedFromBody: (string | undefined)[] = [];

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        idsObservedFromBody.push(runtime.asyncContext.getStore()?.connectionId);
        yield { token: 'a' };
        idsObservedFromBody.push(runtime.asyncContext.getStore()?.connectionId);
        yield { token: 'b' };
      },
    };

    await runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'my-stream',
      stream: stream as never,
      payload: {},
    });

    expect(idsObservedFromBody).toEqual(['c1', 'c1']);
    // Outside the stream advance, the context is auto-scoped.
    expect(runtime.asyncContext.getStore()).toBeUndefined();
  });

  it('runStream rejects a second start of the same event on the same connection by default', async () => {
    // Default per-connection per-event exclusivity. A client cannot run two
    // streams of the same event on the same socket — the second start is
    // rejected with `stream-already-active` carrying the existing stream id.
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();

    const existing: ActiveStream = {
      id: 'existing_1',
      connectionId: connection.id,
      event: 'start-tokens',
      generator: (async function* () {})() as AsyncGenerator<unknown, void, unknown>,
      nudges: [],
      nudgeValidators: new Map(),
      closed: false,
    };
    runtime.activeStreams.set(existing.id, existing);
    connection.activeStreamIds = new Set([existing.id]);

    const stream = {
      stream: { nudges: [], broadcast: false, allowConcurrent: false },
      generator: async function* () {
        yield { token: 'should-not-run' };
      },
    };

    await expect(
      runStream(runtime as Parameters<typeof runStream>[0], connection, {
        scope: {},
        event: 'start-tokens',
        stream: stream as never,
        payload: {},
      }),
    ).rejects.toMatchObject({
      code: 'stream-already-active',
      detail: { event: 'start-tokens', streamId: 'existing_1' },
    });

    // Existing stream is untouched, no second stream registered, and no
    // `__streamOk__` for a stream that never started.
    expect(runtime.activeStreams.has('existing_1')).toBe(true);
    expect(runtime.activeStreams.size).toBe(1);
    expect(protocolMessages.find((m) => m.event === '__streamOk__')).toBeUndefined();
  });

  it('two concurrent starts of the same event — exactly one is rejected', async () => {
    // Pins the atomic check-then-register: an await slipped between them would
    // let both starts through.
    const { runtime } = createStreamRuntime();
    const connection = createConnection();
    const stream = {
      stream: { nudges: [], broadcast: false, allowConcurrent: false },
      generator: async function* () {
        yield { token: 'a' };
      },
    };

    const results = await Promise.allSettled([
      runStream(runtime as Parameters<typeof runStream>[0], connection, {
        scope: {},
        event: 'tok',
        stream: stream as never,
        payload: {},
        wskit: { streamId: 's1', channelScope: null },
      }),
      runStream(runtime as Parameters<typeof runStream>[0], connection, {
        scope: {},
        event: 'tok',
        stream: stream as never,
        payload: {},
        wskit: { streamId: 's2', channelScope: null },
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'stream-already-active',
    });
  });

  it('two concurrent starts of the same event both run when allowConcurrent is set', async () => {
    const { runtime } = createStreamRuntime();
    const connection = createConnection();
    const stream = {
      stream: { nudges: [], broadcast: false, allowConcurrent: true },
      generator: async function* () {
        yield { token: 'a' };
      },
    };

    const results = await Promise.allSettled([
      runStream(runtime as Parameters<typeof runStream>[0], connection, {
        scope: {},
        event: 'tok',
        stream: stream as never,
        payload: {},
        wskit: { streamId: 's1', channelScope: null },
      }),
      runStream(runtime as Parameters<typeof runStream>[0], connection, {
        scope: {},
        event: 'tok',
        stream: stream as never,
        payload: {},
        wskit: { streamId: 's2', channelScope: null },
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });

  it('runStream accepts a second start of a different event on the same connection', async () => {
    const { runtime } = createStreamRuntime();
    const connection = createConnection();

    const existing: ActiveStream = {
      id: 'existing_1',
      connectionId: connection.id,
      event: 'start-tokens',
      generator: (async function* () {})() as AsyncGenerator<unknown, void, unknown>,
      nudges: [],
      nudgeValidators: new Map(),
      closed: false,
    };
    runtime.activeStreams.set(existing.id, existing);
    connection.activeStreamIds = new Set([existing.id]);

    const stream = {
      stream: { nudges: [], broadcast: false, allowConcurrent: false },
      generator: async function* () {
        yield { token: 'summary' };
      },
    };

    await expect(
      runStream(runtime as Parameters<typeof runStream>[0], connection, {
        scope: {},
        event: 'start-summary',
        stream: stream as never,
        payload: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('runStream accepts a same-event start on a different connection', async () => {
    const { runtime } = createStreamRuntime();
    const owner = createConnection('owner');
    const other = createConnection('other');

    const existing: ActiveStream = {
      id: 'existing_1',
      connectionId: owner.id,
      event: 'start-tokens',
      generator: (async function* () {})() as AsyncGenerator<unknown, void, unknown>,
      nudges: [],
      nudgeValidators: new Map(),
      closed: false,
    };
    runtime.activeStreams.set(existing.id, existing);
    owner.activeStreamIds = new Set([existing.id]);

    const stream = {
      stream: { nudges: [], broadcast: false, allowConcurrent: false },
      generator: async function* () {
        yield { token: 'hello' };
      },
    };

    await expect(
      runStream(runtime as Parameters<typeof runStream>[0], other, {
        scope: {},
        event: 'start-tokens',
        stream: stream as never,
        payload: {},
      }),
    ).resolves.toBeUndefined();
  });

  it('runStream allows parallel same-event streams when allowConcurrent is set', async () => {
    // With `.allowConcurrent()` the per-connection per-event check is skipped
    // and both streams run with distinct ids.
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();

    const existing: ActiveStream = {
      id: 'existing_1',
      connectionId: connection.id,
      event: 'start-tokens',
      generator: (async function* () {})() as AsyncGenerator<unknown, void, unknown>,
      nudges: [],
      nudgeValidators: new Map(),
      closed: false,
    };
    runtime.activeStreams.set(existing.id, existing);
    connection.activeStreamIds = new Set([existing.id]);

    const stream = {
      stream: { nudges: [], broadcast: false, allowConcurrent: true },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'start-tokens',
      stream: stream as never,
      payload: {},
    });

    const streamOk = protocolMessages.find((m) => m.event === '__streamOk__');
    expect(streamOk).toBeDefined();
    expect(streamOk!.wskit.streamId).toBe('stream_1');
    expect(runtime.activeStreams.has('existing_1')).toBe(true);
  });

  it('Defer thrown inside a stream fires onError hooks and sends an __error__ with code internal-error', async () => {
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();

    const hookCalls: { error: unknown; event?: string }[] = [];
    runtime.errorHooks = [
      (_ctx, error, event) => {
        hookCalls.push({ error, event });
      },
    ];

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        throw {
          __wskit: 'defer',
          delay: 100,
        };
        yield { token: 'never' };
      },
    };

    await runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'feed',
      stream: stream as never,
      payload: { seed: 1 },
    });

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.event).toBe('feed');
    const err = hookCalls[0]!.error as { code?: string; detail?: { retries?: number } };
    expect(err.code).toBe('internal-error');

    const wire = protocolMessages.find((m) => m.event === '__error__');
    expect(wire).toBeDefined();
    expect(wire!.payload.code).toBe('internal-error');
    expect(wire!.wskit.streamId).toBe('stream_1');
    expect(wire!.payload.detail).toBeUndefined();
  });

  it('adopts a client-supplied streamId from the trigger frame wskit', async () => {
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await runStream(runtime as Parameters<typeof runStream>[0], connection, {
      scope: {},
      event: 'feed',
      stream: stream as never,
      payload: {},
      wskit: { streamId: 'conv-42', channelScope: null },
    });

    const streamOk = protocolMessages.find((m) => m.event === '__streamOk__');
    expect(streamOk!.wskit.streamId).toBe('conv-42');

    const streamEnd = protocolMessages.find((m) => m.event === '__streamEnd__');
    expect(streamEnd!.wskit.streamId).toBe('conv-42');
  });

  it('falls back to a generated streamId when the supplied id is malformed', async () => {
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    // Wrong type, empty string, and over-length string all fall back. The
    // numeric case can never be a valid WSKitProtocol field, so cast it.
    const badWSKits: NonNullable<RunStreamOptions['wskit']>[] = [
      { streamId: 123, channelScope: null } as unknown as NonNullable<RunStreamOptions['wskit']>,
      { streamId: '', channelScope: null },
      { streamId: 'x'.repeat(300), channelScope: null },
    ];
    for (const bad of badWSKits) {
      protocolMessages.length = 0;
      runtime.activeStreams.clear();
      connection.activeStreamIds = undefined;

      await runStream(runtime as Parameters<typeof runStream>[0], connection, {
        scope: {},
        event: 'feed',
        stream: stream as never,
        payload: {},
        wskit: bad,
      });

      const streamOk = protocolMessages.find((m) => m.event === '__streamOk__');
      expect(streamOk!.wskit.streamId).toBe('stream_1');
    }
  });

  it('throws StreamIdCollision when the supplied streamId is already in use', async () => {
    const { runtime } = createStreamRuntime();
    const connection = createConnection();

    runtime.activeStreams.set('conv-42', { id: 'conv-42', closed: false } as ActiveStream);

    const stream = {
      stream: { nudges: [], broadcast: false, allowConcurrent: true },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await expect(
      runStream(runtime as Parameters<typeof runStream>[0], connection, {
        scope: {},
        event: 'feed',
        stream: stream as never,
        payload: {},
        wskit: { streamId: 'conv-42', channelScope: null },
      }),
    ).rejects.toMatchObject({ code: 'stream-id-collision' });
  });
});
