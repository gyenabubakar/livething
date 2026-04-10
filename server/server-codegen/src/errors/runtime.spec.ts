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

  it('suppresses _error when an error hook returns false', async () => {
    const sent: Array<{ event: string; payload: Record<string, unknown> }> = [];

    await sendRuntimeError(
      {
        buildConnectionContext() {
          return { id: 'c1' };
        },
        errorHooks: [
          async () => {
            return false;
          },
        ],
        sendProtocolMessage(_connection, event, payload) {
          sent.push({ event, payload });
        },
      },
      { id: 'c1' } as never,
      new Error('boom'),
      'echo',
    );

    expect(sent).toEqual([]);
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
});
