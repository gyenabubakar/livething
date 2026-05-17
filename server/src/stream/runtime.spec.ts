import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveStream, RuntimeConnection } from '~/_engine/runtime/types.ts';
import { bufferStreamNudge, cancelStream, runStream } from './runtime.ts';

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
    tags: new Set(),
    channelMemberships: new Map(),
    latency: null,
    quality: 'good',
  };
}

function createStreamRuntime() {
  const protocolMessages: { event: string; payload: Record<string, unknown> }[] = [];
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
        event: string,
        payload: Record<string, unknown>,
      ) => {
        protocolMessages.push({ event, payload });
      },
      sendThroughPipeline: (
        _conn: RuntimeConnection,
        _scope: unknown,
        event: string,
        payload: unknown,
      ) => {
        pipelineSends.push({ event, payload });
        return true;
      },
      broadcastToConnections: (
        conns: readonly RuntimeConnection[],
        event: string,
        payload: unknown,
        options?: { namespace?: string; channel?: string; excludeSelf?: boolean },
        excludeConnectionId?: string,
      ) => {
        broadcasts.push({
          event,
          payload,
          options,
          excludeConnectionId,
          targetIds: conns.map((c) => c.id),
        });
      },
      setActiveConnectionId: vi.fn(),
      persistAttachment: vi.fn(),
      logger: { warn: vi.fn() },
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
  it('_streamEnd includes namespace routing metadata', async () => {
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      connection,
      { namespace: { name: 'ai' } as never },
      'stream-prompt',
      stream as never,
      {},
    );

    const streamEnd = protocolMessages.find((m) => m.event === '_streamEnd');
    expect(streamEnd).toBeDefined();
    expect(streamEnd!.payload._namespace).toBe('ai');
  });

  it('_streamEnd includes channel routing metadata', async () => {
    const { runtime, protocolMessages } = createStreamRuntime();
    const connection = createConnection();

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        yield { token: 'hi' };
      },
    };

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      connection,
      { channelName: 'chat', channelScope: 'rooms' },
      'chat-stream',
      stream as never,
      {},
    );

    const streamEnd = protocolMessages.find((m) => m.event === '_streamEnd');
    expect(streamEnd).toBeDefined();
    expect(streamEnd!.payload._channel).toBe('chat');
    expect(streamEnd!.payload._channelScope).toBe('rooms');
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

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      trigger,
      {},
      'broadcast-stream',
      stream as never,
      {},
    );

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
    await runStream(
      runtime as Parameters<typeof runStream>[0],
      trigger,
      { channelName: 'room:123', channelScope: 'rooms' },
      'broadcast-stream',
      stream as never,
      {},
    );

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

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      trigger,
      { channelName: 'room:1', channelScope: 'rooms' },
      'broadcast-stream',
      stream as never,
      {},
    );

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

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      trigger,
      {}, // no channelName — top-level broadcast
      'broadcast-stream',
      stream as never,
      {},
    );

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.targetIds).toEqual(expect.arrayContaining(['trigger', 'other']));
  });

  it('_streamCancel from a non-owner connection is ignored', async () => {
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

    await cancelStream({ activeStreams }, stranger, { _streamId: streamId });

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
      cancelStream({ activeStreams, logger }, owner, { _streamId: 'stream_1' }),
    ).resolves.toBeUndefined();

    expect(activeStreams.has('stream_1')).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, fields] = logger.error.mock.calls[0]!;
    expect(message).toMatch(/stream cleanup threw on _streamCancel/);
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

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      connection,
      {},
      'my-stream',
      stream as never,
      {},
    );

    expect(broadcasts).toHaveLength(0);
  });

  it('Defer thrown from a stream handler logs a warning, fires onError hooks, and sends _error with defer-exhausted code', async () => {
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

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      connection,
      {},
      'stream-event',
      stream as never,
      {},
    );

    expect(handleRuntimeError).not.toHaveBeenCalled();
    expect((runtime.logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatch(/Defer/);
    const errMsg = protocolMessages.find((m) => m.event === '_error');
    expect(errMsg).toBeDefined();
    expect(errMsg!.payload.code).toBe('defer-exhausted');
    expect(errMsg!.payload._streamId).toBe('stream_1');
  });

  it('bufferStreamNudge surfaces _error and returns true for an unknown _streamId', async () => {
    // A frame carrying `_streamId` is claiming to belong to one specific
    // stream. If the id is unknown, the frame is malformed — surface
    // `_error` with `_streamId` routing and treat it as handled so it
    // never falls through to a same-named top-level .incoming() handler.
    const { runtime } = createStreamRuntime();
    const connection = createConnection();
    const handleRuntimeError = vi.fn();
    runtime.handleRuntimeError = handleRuntimeError;

    const result = await bufferStreamNudge(
      runtime as Parameters<typeof bufferStreamNudge>[0],
      connection,
      'nudge-event',
      { _streamId: 'does-not-exist' },
    );

    expect(result).toBe(true);
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    expect(handleRuntimeError).toHaveBeenCalledWith(connection, expect.any(Error), 'nudge-event', {
      _streamId: 'does-not-exist',
    });
  });

  it('bufferStreamNudge surfaces _error and returns true for a closed stream', async () => {
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
      'known-nudge',
      { _streamId: 'stream_1' },
    );

    expect(result).toBe(true);
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
  });

  it('bufferStreamNudge surfaces _error and returns true for a stream owned by a different connection', async () => {
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
      'known-nudge',
      { _streamId: 'stream_1' },
    );

    expect(result).toBe(true);
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
  });

  it('bufferStreamNudge surfaces _error and returns true for an unknown event name on an active stream', async () => {
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
      'unknown-nudge',
      { _streamId: 'stream_1' },
    );

    expect(result).toBe(true);
    expect(activeStream.nudges).toHaveLength(0);
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    expect(handleRuntimeError).toHaveBeenCalledWith(
      connection,
      expect.any(Error),
      'unknown-nudge',
      { _streamId: 'stream_1' },
    );
  });

  it('bufferStreamNudge returns false when the frame carries no _streamId at all', async () => {
    // Frames without `_streamId` do not claim to belong to any stream.
    // The stream layer steps aside and lets the engine route them as
    // top-level events.
    const { runtime } = createStreamRuntime();
    const connection = createConnection();

    const result = await bufferStreamNudge(
      runtime as Parameters<typeof bufferStreamNudge>[0],
      connection,
      'plain-event',
      { value: 'no-stream-id' },
    );

    expect(result).toBe(false);
  });

  it('bufferStreamNudge throws WskitConfigError without routing through handleValidationError when the nudge validator is async', async () => {
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
      nudgeValidators: new Map([['async-nudge', (v: unknown) => Promise.resolve(v)]]),
      closed: false,
    };
    runtime.activeStreams.set('stream_1', activeStream);

    await expect(
      bufferStreamNudge(
        runtime as Parameters<typeof bufferStreamNudge>[0],
        connection,
        'async-nudge',
        { _streamId: 'stream_1' },
      ),
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
      nudgeValidators: new Map([
        [
          'pause',
          (value: unknown) => {
            if ((value as { bad?: boolean }).bad) throw new Error('schema rejects bad=true');
            return value;
          },
        ],
      ]),
      closed: false,
    };
    runtime.activeStreams.set('stream_1', activeStream);

    const handleRuntimeError = vi.fn();
    runtime.handleRuntimeError = handleRuntimeError;

    const result = await bufferStreamNudge(
      runtime as Parameters<typeof bufferStreamNudge>[0],
      connection,
      'pause',
      { _streamId: 'stream_1', bad: true },
    );

    expect(result).toBe(true);
    expect(handleValidationError).toHaveBeenCalledTimes(1);
    expect(handleValidationError).toHaveBeenCalledWith(connection, 'pause', expect.any(Error));
    // The wire `_error` must reach the client with `_streamId` routing so the
    // client can correlate the failure to the right stream-error handler.
    expect(handleRuntimeError).toHaveBeenCalledTimes(1);
    expect(handleRuntimeError).toHaveBeenCalledWith(connection, expect.any(Error), 'pause', {
      _streamId: 'stream_1',
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

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      connection,
      {},
      'my-stream',
      stream as never,
      {},
    );

    // First call: stream ID was added to activeStreamIds before yield
    expect(snapshots[0]).toContain('stream_1');
    // Last call: stream ID was removed from activeStreamIds in finally
    expect(snapshots[snapshots.length - 1]).not.toContain('stream_1');
    expect(connection.activeStreamIds?.has('stream_1')).toBe(false);
  });

  it('generator body sees the stream owner connection id via setActiveConnectionId', async () => {
    // Pre-fix the engine bracketed setActiveConnectionId around generator
    // construction (which only returns the iterator, doesn't run the body).
    // By the time `iterator.next()` ran the body, the active id was already
    // cleared. Module APIs that call hooks.getState() inside a stream
    // generator saw `undefined` instead of the stream owner's id.
    const { runtime } = createStreamRuntime();
    const connection = createConnection();

    let activeId: string | undefined;
    runtime.setActiveConnectionId = vi.fn((id?: string) => {
      activeId = id;
    });

    const idsObservedFromBody: (string | undefined)[] = [];

    const stream = {
      stream: { nudges: [], broadcast: false },
      generator: async function* () {
        // Read at the top of each yield iteration. The bracket must be set
        // around iterator.next() so this reads the stream owner's id.
        idsObservedFromBody.push(activeId);
        yield { token: 'a' };
        idsObservedFromBody.push(activeId);
        yield { token: 'b' };
      },
    };

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      connection,
      {},
      'my-stream',
      stream as never,
      {},
    );

    expect(idsObservedFromBody).toEqual(['c1', 'c1']);
    // After the stream ends, the bracket has restored undefined.
    expect(activeId).toBeUndefined();
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
      runStream(
        runtime as Parameters<typeof runStream>[0],
        connection,
        {},
        'start-tokens',
        stream as never,
        {},
      ),
    ).rejects.toMatchObject({
      code: 'stream-already-active',
      detail: { event: 'start-tokens', _streamId: 'existing_1' },
    });

    // Existing stream is untouched, no second stream registered, and no
    // `_streamOk` for a stream that never started.
    expect(runtime.activeStreams.has('existing_1')).toBe(true);
    expect(runtime.activeStreams.size).toBe(1);
    expect(protocolMessages.find((m) => m.event === '_streamOk')).toBeUndefined();
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
      runStream(
        runtime as Parameters<typeof runStream>[0],
        connection,
        {},
        'start-summary',
        stream as never,
        {},
      ),
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
      runStream(
        runtime as Parameters<typeof runStream>[0],
        other,
        {},
        'start-tokens',
        stream as never,
        {},
      ),
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

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      connection,
      {},
      'start-tokens',
      stream as never,
      {},
    );

    const streamOk = protocolMessages.find((m) => m.event === '_streamOk');
    expect(streamOk).toBeDefined();
    expect(streamOk!.payload._streamId).toBe('stream_1');
    expect(runtime.activeStreams.has('existing_1')).toBe(true);
  });

  it('Defer thrown inside a stream fires onError hooks and sends an _error with code defer-exhausted', async () => {
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

    await runStream(
      runtime as Parameters<typeof runStream>[0],
      connection,
      {},
      'feed',
      stream as never,
      { seed: 1 },
    );

    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.event).toBe('feed');
    const err = hookCalls[0]!.error as { code?: string; detail?: { retries?: number } };
    expect(err.code).toBe('defer-exhausted');
    expect(err.detail?.retries).toBe(0);

    const wire = protocolMessages.find((m) => m.event === '_error');
    expect(wire).toBeDefined();
    expect(wire!.payload.code).toBe('defer-exhausted');
    expect(wire!.payload._streamId).toBe('stream_1');
    expect(wire!.payload.detail).toBeUndefined();
  });
});
