import { Block } from '@wskit/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { dedup } from '~/primitives/dedup.ts';
import { intercept } from '~/primitives/intercept.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface TestContract {
  incoming: { message: { text: string }; notify: { id: string } };
  outgoing: { ping: Record<string, never> };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function build<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<TestContract, P>
) {
  const socket = client<TestContract>()(connect('wss://test'), ...primitives);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();
  return { socket, ws };
}

describe('intercept — non-Block throw drops message', () => {
  it('drops the message and does not invoke the top-level handler when an intercept throws a plain Error', () => {
    const handler = vi.fn();
    const { socket, ws } = build(
      intercept(() => {
        throw new Error('unexpected problem');
      }),
    );
    socket.on('message', handler);
    ws.emit({ event: 'message', payload: { text: 'hello' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not run a later intercept after an earlier one throws a plain Error', () => {
    const laterIntercept = vi.fn();
    const handler = vi.fn();
    const { socket, ws } = build(
      intercept(() => {
        throw new Error('boom');
      }),
      intercept(laterIntercept),
    );
    socket.on('message', handler);
    ws.emit({ event: 'message', payload: { text: 'hello' } });
    expect(laterIntercept).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('intercept — first Block stops later intercepts', () => {
  it('does not call a second intercept when the first throws Block', () => {
    const secondIntercept = vi.fn();
    const handler = vi.fn();
    const { socket, ws } = build(
      intercept(() => {
        throw Block;
      }),
      intercept(secondIntercept),
    );
    socket.on('message', handler);
    ws.emit({ event: 'message', payload: { text: 'hi' } });
    expect(secondIntercept).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('still runs a second intercept when the first does NOT throw Block', () => {
    const secondIntercept = vi.fn();
    const { socket, ws } = build(
      intercept(() => {
        /* pass through */
      }),
      intercept(secondIntercept),
    );
    socket.on('message', () => {});
    ws.emit({ event: 'message', payload: { text: 'hi' } });
    expect(secondIntercept).toHaveBeenCalledTimes(1);
  });
});

describe('intercept — transform chains to next intercept', () => {
  it('passes the transformed message (not the original) to the next intercept', () => {
    const secondIntercept = vi.fn((m) => m);
    const { socket, ws } = build(
      intercept((m) => ({ ...m, payload: { text: 'transformed' } })),
      intercept(secondIntercept),
    );
    socket.on('message', () => {});
    ws.emit({ event: 'message', payload: { text: 'original' } });
    expect(secondIntercept).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { text: 'transformed' } }),
    );
    expect(secondIntercept).not.toHaveBeenCalledWith(
      expect.objectContaining({ payload: { text: 'original' } }),
    );
  });

  it('top-level handler receives the final transformed payload, not the original', () => {
    const handler = vi.fn();
    const { socket, ws } = build(
      intercept((m) => ({ ...m, payload: { text: 'first-pass' } })),
      intercept((m) => ({ ...m, payload: { text: 'second-pass' } })),
    );
    socket.on('message', handler);
    ws.emit({ event: 'message', payload: { text: 'original' } });
    expect(handler).toHaveBeenCalledWith({ text: 'second-pass' });
  });

  it('intercepts never see a frame that a primitive (dedup) already swallowed', () => {
    const interceptFn = vi.fn();
    const { socket, ws } = build(dedup(), intercept(interceptFn));
    socket.on('message', () => {});
    // First delivery — a new messageId, goes through
    ws.emit({ event: 'message', payload: { text: 'hi' }, __wskit: { messageId: 'msg-1' } });
    expect(interceptFn).toHaveBeenCalledTimes(1);

    interceptFn.mockClear();

    // Second delivery — duplicate, dedup swallows it before intercepts run
    ws.emit({ event: 'message', payload: { text: 'hi' }, __wskit: { messageId: 'msg-1' } });
    expect(interceptFn).not.toHaveBeenCalled();
  });
});

describe('intercept — __error__ frame bypasses intercepts', () => {
  it('does not invoke a registered intercept for an unclaimed __error__ frame', () => {
    const interceptFn = vi.fn();
    const { socket, ws } = build(intercept(interceptFn));
    socket.onError(() => {});
    ws.emit({ event: '__error__', payload: { code: 'forbidden', detail: {} } });
    expect(interceptFn).not.toHaveBeenCalled();
  });

  it('still fires onError when an intercept is registered and an __error__ frame arrives', () => {
    const onErr = vi.fn();
    const { socket, ws } = build(
      intercept(() => {
        /* some intercept */
      }),
    );
    socket.onError(onErr);
    ws.emit({ event: '__error__', payload: { code: 'not-found', detail: {} } });
    expect(onErr).toHaveBeenCalledTimes(1);
  });
});
