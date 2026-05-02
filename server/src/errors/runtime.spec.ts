import { WskitError } from '@wskit/core';
import { describe, expect, it } from 'vitest';
import {
  normalizeRuntimeErrorPayload,
  notifyValidationError,
  sendRuntimeError,
} from './runtime.ts';

describe('errors runtime', () => {
  it('normalizes WskitError values into _error payloads', () => {
    expect(
      normalizeRuntimeErrorPayload(new WskitError('forbidden', { reason: 'nope' }), {
        _streamId: 's1',
      }),
    ).toEqual({
      code: 'forbidden',
      detail: { reason: 'nope' },
      _streamId: 's1',
    });
  });

  it('normalizes unknown values into internal-error payloads', () => {
    expect(normalizeRuntimeErrorPayload(new Error('boom'))).toEqual({
      code: 'internal-error',
    });
  });

  it('still sends _error after running error hooks', async () => {
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
        sendProtocolMessage(_connection, event, payload) {
          sent.push({ event, payload });
        },
      },
      { id: 'c1' } as never,
      new Error('boom'),
      'echo',
    );

    expect(observed).toEqual(['echo']);
    expect(sent).toEqual([{ event: '_error', payload: { code: 'internal-error' } }]);
  });

  it('runs error hooks for WskitError values too', async () => {
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
      new WskitError('forbidden', {}),
      'echo',
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
      '_subscribe',
      new Error('bad'),
      { channelName: 'room-1' } as never,
    );

    expect(events).toEqual(['_subscribe:room-1']);
  });

  it('isolates a throwing onError hook so subsequent hooks and the _error send still run', async () => {
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
        sendProtocolMessage(_connection, event, payload) {
          sent.push({ event, payload });
        },
      },
      { id: 'c1' } as never,
      new Error('boom'),
      'echo',
    );

    // Second hook still ran despite the first throwing.
    expect(observed).toEqual(['second']);
    // Logger received the isolation message.
    expect(errors).toEqual(['[wskit] onError hook threw; sending _error to client anyway']);
    // _error frame was sent exactly once with the normalized payload.
    expect(sent).toEqual([{ event: '_error', payload: { code: 'internal-error' } }]);
  });

  it('warns when a thrown WskitError was never declared', async () => {
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
        sendProtocolMessage(_connection, event, payload) {
          sent.push({ event, payload });
        },
      },
      { id: 'c1' } as never,
      new WskitError('quota-exceeded', { limit: 1 }),
      'charge-card',
    );

    expect(warnings).toEqual(['[wskit] Thrown WskitError was not declared with errors(...)']);
    expect(sent).toEqual([
      {
        event: '_error',
        payload: { code: 'quota-exceeded', detail: { limit: 1 } },
      },
    ]);
  });
});
