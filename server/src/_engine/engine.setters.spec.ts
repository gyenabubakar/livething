/* oxlint-disable @typescript-eslint/no-explicit-any */
import { server } from '~/_builder/server-builder.ts';
import { Engine } from '~/_engine/engine.ts';
import { describe, expect, it, vi } from 'vitest';

function makeEngine() {
  const def = server('test').build();
  return new Engine(def as any, { adapterId: 'test' });
}

describe('Engine.setLogger', () => {
  it('routes engine log calls through the adapter-supplied Logger', () => {
    const engine = makeEngine();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();

    engine.setLogger({ info, warn, error });

    const logger = engine.getLogger();
    logger.info('hello', { a: 1 });
    logger.warn('careful', { b: 2 });
    logger.error('boom', { c: 3 });

    expect(info).toHaveBeenCalledWith('hello', { a: 1 });
    expect(warn).toHaveBeenCalledWith('careful', { b: 2 });
    expect(error).toHaveBeenCalledWith('boom', { c: 3 });
  });

  it('falls back to a console-backed Logger when setLogger is never called', () => {
    const engine = makeEngine();
    const logger = engine.getLogger();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('replaces the active Logger when setLogger is called more than once', () => {
    const engine = makeEngine();
    const first = vi.fn();
    const second = vi.fn();

    engine.setLogger({ info: first, warn: () => {}, error: () => {} });
    engine.setLogger({ info: second, warn: () => {}, error: () => {} });

    engine.getLogger().info('after-replace');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('after-replace');
  });
});

describe('Engine.sendProtocolMessage — non-serializable payloads', () => {
  function fakeConnection() {
    const sent: string[] = [];
    return {
      sent,
      conn: {
        descriptor: { send: (frame: string) => sent.push(frame) },
      } as any,
    };
  }

  it('sends a fallback _error frame when the payload contains a BigInt', () => {
    const engine = makeEngine();
    const error = vi.fn();
    engine.setLogger({ info: () => {}, warn: () => {}, error });
    const { sent, conn } = fakeConnection();

    engine.sendProtocolMessage(conn, '_error', {
      code: 'billing-failed',
      detail: { amount: 1n },
      _messageId: 'm-1',
      _channel: 'room',
    });

    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0] as string);
    expect(parsed.event).toBe('_error');
    expect(parsed.payload.code).toBe('internal-error');
    expect(parsed.payload._messageId).toBe('m-1');
    expect(parsed.payload._channel).toBe('room');
    expect('detail' in parsed.payload).toBe(false);
    expect(error).toHaveBeenCalled();
  });

  it('sends a fallback _error when the payload has a circular reference', () => {
    const engine = makeEngine();
    engine.setLogger({ info: () => {}, warn: () => {}, error: () => {} });
    const { sent, conn } = fakeConnection();
    const circular: Record<string, unknown> = { code: 'oops' };
    circular.self = circular;

    engine.sendProtocolMessage(conn, '_error', {
      code: 'oops',
      detail: circular,
      _streamId: 's-9',
    });

    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0] as string);
    expect(parsed.payload.code).toBe('internal-error');
    expect(parsed.payload._streamId).toBe('s-9');
  });

  it('does not throw out of the dispatcher when serialization fails', () => {
    const engine = makeEngine();
    engine.setLogger({ info: () => {}, warn: () => {}, error: () => {} });
    const { conn } = fakeConnection();
    expect(() =>
      engine.sendProtocolMessage(conn, '_error', {
        code: 'bad',
        detail: { n: 1n },
      }),
    ).not.toThrow();
  });
});

describe('Engine.sendReplay — non-serializable payloads', () => {
  function fakeConnection() {
    const sent: string[] = [];
    return {
      sent,
      conn: {
        descriptor: { send: (frame: string) => sent.push(frame) },
      } as any,
    };
  }

  it('sends a fallback _error frame when a replay row contains a BigInt', () => {
    const engine = makeEngine();
    const error = vi.fn();
    engine.setLogger({ info: () => {}, warn: () => {}, error });
    const { sent, conn } = fakeConnection();

    engine.sendReplay(
      conn,
      'lobby',
      null,
      'chat-msg',
      { text: 'hi', reactions: 7n },
      {
        seq: 42,
        messageId: 'm-7',
      },
    );

    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0] as string);
    // The wire event flips to _error; routing markers from the row survive
    // so the client can correlate the failure to the right channel and
    // sequence number.
    expect(parsed.event).toBe('_error');
    expect(parsed.payload.code).toBe('internal-error');
    expect(parsed.payload._channel).toBe('lobby');
    expect(parsed.payload._seq).toBe(42);
    expect(parsed.payload._messageId).toBe('m-7');
    expect('reactions' in parsed.payload).toBe(false);
    expect(error).toHaveBeenCalled();
  });

  it('does not throw out of the replay loop when serialization fails', () => {
    const engine = makeEngine();
    engine.setLogger({ info: () => {}, warn: () => {}, error: () => {} });
    const { conn } = fakeConnection();
    const circular: Record<string, unknown> = { text: 'hi' };
    circular.self = circular;

    expect(() =>
      engine.sendReplay(conn, null, null, 'chat-msg', circular, {
        seq: 1,
        messageId: 'm-1',
      }),
    ).not.toThrow();
  });

  it('still sends the row normally when the payload is serializable', () => {
    const engine = makeEngine();
    engine.setLogger({ info: () => {}, warn: () => {}, error: () => {} });
    const { sent, conn } = fakeConnection();

    engine.sendReplay(
      conn,
      'lobby',
      'rooms',
      'chat-msg',
      { text: 'ok' },
      {
        seq: 1,
        messageId: 'm-1',
      },
    );

    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0] as string);
    expect(parsed.event).toBe('chat-msg');
    expect(parsed.payload).toEqual({
      text: 'ok',
      _seq: 1,
      _messageId: 'm-1',
      _channel: 'lobby',
      _channelScope: 'rooms',
    });
  });
});

describe('Engine internal upgrade slot', () => {
  it('throws when one primitive calls onUpgrade twice from the same __setup', () => {
    // Per-primitive guard. Each primitive's __setup gets its own
    // EngineAccess object, so the closure flag tracks "have I
    // registered yet" within one primitive's setup scope.
    const engine = makeEngine();
    const access = (
      engine as unknown as {
        createEngineAccess(): { onUpgrade(h: () => unknown): void };
      }
    ).createEngineAccess();

    access.onUpgrade(() => ({}));
    expect(() => access.onUpgrade(() => ({}))).toThrow(/may only register one onUpgrade hook/);
  });

  it('lets two different primitives each register one onUpgrade hook', () => {
    // Two fresh access objects (one per primitive). Each one tracks its
    // own counter, so both can register without colliding.
    const engine = makeEngine();
    const accessA = (
      engine as unknown as {
        createEngineAccess(): { onUpgrade(h: () => unknown): void };
      }
    ).createEngineAccess();
    const accessB = (
      engine as unknown as {
        createEngineAccess(): { onUpgrade(h: () => unknown): void };
      }
    ).createEngineAccess();

    expect(() => accessA.onUpgrade(() => ({}))).not.toThrow();
    expect(() => accessB.onUpgrade(() => ({}))).not.toThrow();

    const hooks = (engine as unknown as { hooks: { upgrade: readonly unknown[] } }).hooks;
    expect(hooks.upgrade).toHaveLength(2);
  });
});

describe('Engine builder upgrade slot', () => {
  it('throws on the second setBuilderUpgradeHook registration', () => {
    // Defense-in-depth at the engine surface. The builder's
    // duplicate-identity check already throws if the user calls
    // `.onUpgrade(...)` twice on the builder; this guard covers any
    // path that bypasses the builder (e.g. an internal primitive
    // routing through setBuilderUpgradeHook).
    const engine = makeEngine();
    const access = (
      engine as unknown as {
        createEngineAccess(): { setBuilderUpgradeHook(h: () => unknown): void };
      }
    ).createEngineAccess();

    access.setBuilderUpgradeHook(() => ({}));
    expect(() => access.setBuilderUpgradeHook(() => ({}))).toThrow(/already set/);
  });
});

describe('Engine.getCompiled', () => {
  it('returns the compiled handler definition built at construction', () => {
    const engine = makeEngine();
    const compiled = engine.getCompiled();
    expect(compiled).toBeDefined();
    expect(compiled.incoming).toBeInstanceOf(Map);
    expect(compiled.outgoing).toBeInstanceOf(Map);
  });

  it('declared error codes include every built-in error the engine emits', () => {
    // sendRuntimeError logs a warning when an emitted WskitError is not in
    // the declared set. Built-in errors (validation-failed,
    // channel-not-found, channel-not-subscribed, namespace-not-found) must
    // all be present so the engine never warns about its own emits.
    const engine = makeEngine();
    const declared = (engine as unknown as { declaredErrorCodes: Set<string> }).declaredErrorCodes;
    expect(declared.has('validation-failed')).toBe(true);
    expect(declared.has('channel-not-found')).toBe(true);
    expect(declared.has('channel-not-subscribed')).toBe(true);
    expect(declared.has('namespace-not-found')).toBe(true);
  });
});
