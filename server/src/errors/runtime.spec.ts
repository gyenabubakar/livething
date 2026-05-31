import { WSKitError } from '@wskit/core';
import { describe, expect, it } from 'vitest';
import { normalizeRuntimeError, notifyValidationError, sendRuntimeError } from './runtime.ts';

describe('errors runtime', () => {
  it('normalizes WSKitError values into __error__ payload and wskit halves', () => {
    expect(
      normalizeRuntimeError(new WSKitError('forbidden', { reason: 'nope' }), {
        streamId: 's1',
      }),
    ).toEqual({
      payload: { code: 'forbidden', detail: { reason: 'nope' } },
      wskit: { streamId: 's1' },
    });
  });

  it('normalizes unknown values into internal-error payloads', () => {
    expect(normalizeRuntimeError(new Error('boom'))).toEqual({
      payload: { code: 'internal-error' },
      wskit: {},
    });
  });

  it('collapses an undeclared WSKitError code into internal-error', () => {
    expect(
      normalizeRuntimeError(
        new WSKitError('quota-exceeded', { limit: 1 }),
        { correlationId: 'r1' },
        new Set(['forbidden']),
      ),
    ).toEqual({
      payload: { code: 'internal-error' },
      wskit: { correlationId: 'r1' },
    });
  });

  it('keeps a declared WSKitError code and detail', () => {
    expect(
      normalizeRuntimeError(
        new WSKitError('forbidden', { reason: 'nope' }),
        undefined,
        new Set(['forbidden']),
      ),
    ).toEqual({
      payload: { code: 'forbidden', detail: { reason: 'nope' } },
      wskit: {},
    });
  });

  it('still sends __error__ after running error hooks', async () => {
    const sent: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const observed: string[] = [];

    await sendRuntimeError(
      {
        buildConnectionContext() {
          return { id: 'c1' };
        },
        declaredErrorCodes: new Set(),
        errorHooks: [
          async (_ctx, _error, event) => {
            observed.push(String(event));
          },
        ],
        logger: {
          warn() {},
          error() {},
        },
        sendProtocolMessage(_connection, opts) {
          sent.push({ event: opts.event, payload: opts.payload });
        },
      },
      { id: 'c1' } as never,
      { error: new Error('boom'), event: 'echo' },
    );

    expect(observed).toEqual(['echo']);
    expect(sent).toEqual([{ event: '__error__', payload: { code: 'internal-error' } }]);
  });

  it('runs error hooks for WSKitError values too', async () => {
    const observed: string[] = [];

    await sendRuntimeError(
      {
        buildConnectionContext() {
          return { id: 'c1' };
        },
        declaredErrorCodes: new Set(['forbidden']),
        errorHooks: [
          async () => {
            observed.push('hook');
          },
        ],
        logger: {
          warn() {},
          error() {},
        },
        sendProtocolMessage() {},
      },
      { id: 'c1' } as never,
      { error: new WSKitError('forbidden', {}), event: 'echo' },
    );

    expect(observed).toEqual(['hook']);
  });

  it('notifies validation hooks with the scoped context', async () => {
    const events: string[] = [];

    await notifyValidationError(
      {
        buildConnectionContext(_connection, scope) {
          return { scope };
        },
        validationErrorHooks: [
          async (ctx, event) => {
            events.push(
              `${event}:${String((ctx as { scope?: { channelName?: string } }).scope?.channelName ?? '')}`,
            );
          },
        ],
      },
      { id: 'c1' } as never,
      {
        event: '__subscribe__',
        validationError: new Error('bad'),
        scope: { channelName: 'room-1' } as never,
      },
    );

    expect(events).toEqual(['__subscribe__:room-1']);
  });

  it('isolates a throwing onError hook so subsequent hooks and the __error__ send still run', async () => {
    const sent: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const observed: string[] = [];
    const errors: string[] = [];

    await sendRuntimeError(
      {
        buildConnectionContext() {
          return { id: 'c1' };
        },
        declaredErrorCodes: new Set(),
        errorHooks: [
          () => {
            throw new Error('hook blew up');
          },
          async () => {
            observed.push('second');
          },
        ],
        logger: {
          warn() {},
          error(message) {
            errors.push(message);
          },
        },
        sendProtocolMessage(_connection, opts) {
          sent.push({ event: opts.event, payload: opts.payload });
        },
      },
      { id: 'c1' } as never,
      { error: new Error('boom'), event: 'echo' },
    );

    // Second hook still ran despite the first throwing.
    expect(observed).toEqual(['second']);
    // Logger received the isolation message.
    expect(errors).toEqual(['[wskit] onError hook threw; sending __error__ to client anyway']);
    // __error__ frame was sent exactly once with the normalized payload.
    expect(sent).toEqual([{ event: '__error__', payload: { code: 'internal-error' } }]);
  });

  it('warns and sends internal-error when a thrown WSKitError was never declared', async () => {
    const warnings: string[] = [];
    const sent: Array<{ event: string; payload: Record<string, unknown> }> = [];

    await sendRuntimeError(
      {
        buildConnectionContext() {
          return { id: 'c1' };
        },
        declaredErrorCodes: new Set(['forbidden']),
        errorHooks: [],
        logger: {
          warn(message) {
            warnings.push(message);
          },
          error() {},
        },
        sendProtocolMessage(_connection, opts) {
          sent.push({ event: opts.event, payload: opts.payload });
        },
      },
      { id: 'c1' } as never,
      { error: new WSKitError('quota-exceeded', { limit: 1 }), event: 'charge-card' },
    );

    expect(warnings).toEqual([
      '[wskit] Thrown WSKitError was not declared in the contract errors: [...] list',
    ]);
    // An undeclared code can't be inferred by InferClient, so the client gets
    // internal-error rather than a code it can't type.
    expect(sent).toEqual([{ event: '__error__', payload: { code: 'internal-error' } }]);
  });

  it('builds the onError hook ctx with the scope resolved from routing markers', async () => {
    const builtScopes: unknown[] = [];
    const fakeChannel = { name: 'rooms' };

    await sendRuntimeError(
      {
        buildConnectionContext(_connection, scope) {
          builtScopes.push(scope);
          return { id: 'c1' };
        },
        resolveScopeFromRouting(routing) {
          if (typeof routing.channel === 'string' && typeof routing.channelScope === 'string') {
            return {
              channel: fakeChannel as never,
              channelName: routing.channel,
              channelScope: routing.channelScope,
            };
          }
          return undefined;
        },
        declaredErrorCodes: new Set(),
        errorHooks: [async () => {}, async () => {}],
        logger: { warn() {}, error() {} },
        sendProtocolMessage() {},
      },
      { id: 'c1' } as never,
      {
        error: new Error('boom'),
        event: 'post',
        routing: { channel: 'room-7', channelScope: 'rooms' },
      },
    );

    expect(builtScopes).toEqual([
      { channel: fakeChannel, channelName: 'room-7', channelScope: 'rooms' },
      { channel: fakeChannel, channelName: 'room-7', channelScope: 'rooms' },
    ]);
  });

  it('falls back to top-level ctx when routing does not resolve to a known scope', async () => {
    const builtScopes: unknown[] = [];

    await sendRuntimeError(
      {
        buildConnectionContext(_connection, scope) {
          builtScopes.push(scope);
          return { id: 'c1' };
        },
        resolveScopeFromRouting() {
          return undefined;
        },
        declaredErrorCodes: new Set(),
        errorHooks: [async () => {}],
        logger: { warn() {}, error() {} },
        sendProtocolMessage() {},
      },
      { id: 'c1' } as never,
      { error: new Error('boom'), event: 'post', routing: { namespace: 'unknown' } },
    );

    expect(builtScopes).toEqual([undefined]);
  });
});
