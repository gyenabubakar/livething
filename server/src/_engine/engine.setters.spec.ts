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
