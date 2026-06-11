import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketConfig } from '~/internal/config.ts';
import type { WireMessage } from '~/internal/runtime.ts';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';
import type { SocketContract } from '~/types.ts';

interface C extends SocketContract {
  incoming: {
    anything: unknown;
    '42': unknown;
    null: unknown;
    ping: Record<string, never>;
    message: { text: string };
    test: { n?: number };
    chunk: { data: string };
  };
  channels: {
    chat: {
      incoming: { message: { text: string } };
    };
  };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

/** Build a basic connected socket with optional extra primitives. */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function connected<const P extends readonly Primitive<any, any>[]>(
  ...extras: [...P] & ValidatePrimitives<C, P>
) {
  const socket = client<C>()(connect('wss://test'), ...extras);
  socket.connect();
  MockWebSocket.last().open();
  return { socket, ws: MockWebSocket.last() };
}

/** Build a primitive spec that only applies config, for injecting parseBinary etc. */
function configPrimitive(apply: (config: SocketConfig) => void): Primitive {
  return { _tag: 'test-config', applyConfig: apply };
}

let primitiveCounter = 0;

/** Build a primitive runtime with a given onIncoming hook. Each call gets a unique tag. */
function incomingPrimitive(onIncoming: (message: WireMessage) => WireMessage | null): Primitive {
  const tag = `test-primitive-${++primitiveCounter}`;
  return {
    _tag: tag,
    setup: () => ({ id: tag, onIncoming }),
  };
}

describe('incoming pipeline — malformed text frame', () => {
  it('swallows an unparseable text frame and keeps the socket alive', () => {
    const handler = vi.fn();
    // Supply a custom parse that always throws so we can control the failure
    const parseSpec = configPrimitive((config) => {
      config.parse = () => {
        throw new SyntaxError('bad json');
      };
    });
    const { socket, ws } = connected(parseSpec);
    socket.on('anything', handler);

    // emitRaw sends the string directly without JSON-stringifying
    ws.emitRaw('this is not valid json');

    expect(handler).not.toHaveBeenCalled();
    expect(socket.getState()).toBe('open');
  });
});

describe('incoming pipeline — binary frame', () => {
  it('surfaces a binary frame on the error event instead of throwing out of onmessage', () => {
    const handler = vi.fn();
    const { socket, ws } = connected();
    socket.on('anything', handler);
    const onError = vi.fn();
    socket.onError(onError);

    expect(() => ws.emitRaw(new ArrayBuffer(4))).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(handler).not.toHaveBeenCalled();
  });

  it('rethrows an unclaimed __error__ out-of-band when no onError listener is attached', () => {
    const scheduled: Array<() => void> = [];
    const queue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb) => {
      scheduled.push(cb);
    });
    try {
      const { ws } = connected();
      ws.emit({ event: '__error__', payload: { code: 'server-boom' } });
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toThrow();
    } finally {
      queue.mockRestore();
    }
  });
});

describe('incoming pipeline — defaultParse event field validation', () => {
  it('drops a syntactically valid JSON frame whose event field is not a string', () => {
    const handler = vi.fn();
    const { socket, ws } = connected();
    socket.on('42', handler);
    socket.on('null', handler);

    // numeric event — valid JSON but event is a number, not a string
    ws.emitRaw(JSON.stringify({ event: 42, payload: {} }));
    // missing event field
    ws.emitRaw(JSON.stringify({ payload: {} }));
    // null event
    ws.emitRaw(JSON.stringify({ event: null, payload: {} }));

    expect(handler).not.toHaveBeenCalled();
    expect(socket.getState()).toBe('open');
  });
});

describe('incoming pipeline — server ping auto-pong', () => {
  it('answers a raw "ping" with a raw "pong" and does NOT dispatch it to any on() handler', () => {
    const pingHandler = vi.fn();
    const { socket, ws } = connected();
    socket.on('ping', pingHandler);

    ws.emit('ping');

    // The reply is the bare text "pong" — the only form the server records and
    // the form the Cloudflare hibernation auto-response uses.
    expect(ws.sent).toContain('pong');
    expect(pingHandler).not.toHaveBeenCalled();
  });
});

describe('incoming pipeline — scoped frame top-level guard', () => {
  it('does not double-dispatch a channel-tagged frame to a top-level on() handler', () => {
    const channelHandler = vi.fn();
    const topHandler = vi.fn();

    const socket = client<C>()(connect('wss://test'), channels());
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    // Subscribe the channel so it is active
    socket.channel('chat').subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: { source: 'client' },
      __wskit: { channel: 'chat' },
    });

    socket.channel('chat').on('message', channelHandler);
    socket.on('message', topHandler);

    // A channel-scoped event: channels.onIncoming routes it AND returns message (not null),
    // but _processIncoming's top-level guard sees envelope.channel is set → skips top-level
    ws.emit({ event: 'message', payload: { text: 'hi' }, __wskit: { channel: 'chat' } });

    expect(channelHandler).toHaveBeenCalledWith({ text: 'hi' });
    expect(topHandler).not.toHaveBeenCalled();
  });

  it('does not dispatch a streamId-tagged frame to a top-level on() handler', () => {
    const topHandler = vi.fn();
    const { socket, ws } = connected();
    socket.on('chunk', topHandler);

    // streamId is set → the top-level guard filters it out, no handler fires
    ws.emitRaw(
      JSON.stringify({
        event: 'chunk',
        payload: { data: 'a' },
        __wskit: { streamId: 's1', seq: 1 },
      }),
    );

    expect(topHandler).not.toHaveBeenCalled();
  });
});

describe('incoming pipeline — primitive onIncoming throw is isolated', () => {
  it('contains the throw — sibling primitives and top-level dispatch still run', () => {
    const secondPrimitiveHandler = vi.fn();
    const topHandler = vi.fn();

    const throwing = incomingPrimitive(() => {
      throw new Error('primitive exploded');
    });
    const second = incomingPrimitive((msg) => {
      secondPrimitiveHandler();
      return msg;
    });

    const { socket, ws } = connected(throwing, second);
    socket.onError(() => {});
    socket.on('test', topHandler);

    // The throw is caught: it does NOT escape onmessage. The throwing primitive
    // is skipped, the message continues unchanged, so the sibling primitive and
    // the top-level handler both still run for this frame.
    expect(() => ws.emit({ event: 'test', payload: {} })).not.toThrow();
    expect(secondPrimitiveHandler).toHaveBeenCalled();
    expect(topHandler).toHaveBeenCalled();
  });

  it('socket stays open and keeps delivering after a primitive onIncoming throws', () => {
    let shouldThrow = true;
    const topHandler = vi.fn();

    const conditional = incomingPrimitive((msg) => {
      if (shouldThrow) throw new Error('first frame crash');
      return msg;
    });

    const { socket, ws } = connected(conditional);
    socket.onError(() => {});
    socket.on('test', topHandler);

    // First frame: the throw is contained and the frame still reaches dispatch.
    expect(() => ws.emit({ event: 'test', payload: { n: 1 } })).not.toThrow();
    expect(topHandler).toHaveBeenCalledWith({ n: 1 });
    expect(socket.getState()).toBe('open');

    // A later non-throwing frame is delivered normally too.
    shouldThrow = false;
    ws.emit({ event: 'test', payload: { n: 2 } });
    expect(topHandler).toHaveBeenCalledWith({ n: 2 });
  });

  it('surfaces the throw on the error event', () => {
    const boom = new Error('boom');
    const throwing = incomingPrimitive(() => {
      throw boom;
    });
    const { socket, ws } = connected(throwing);
    const onError = vi.fn();
    socket.onError(onError);

    ws.emit({ event: 'test', payload: {} });
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('rethrows out-of-band to the global handler when nothing is listening', () => {
    const scheduled: Array<() => void> = [];
    const queue = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb) => {
      scheduled.push(cb);
    });
    try {
      const boom = new Error('boom');
      const throwing = incomingPrimitive(() => {
        throw boom;
      });
      const { ws } = connected(throwing);

      ws.emit({ event: 'test', payload: {} }); // no error listener → rethrow out-of-band
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toThrow(boom);
    } finally {
      queue.mockRestore();
    }
  });
});

describe('[BUG dispatch-set-mutation] handler registered inside a dispatch does not receive the triggering message', () => {
  it('[BUG dispatch-set-mutation] a handler added by another handler mid-dispatch must not fire for that same message', () => {
    const { socket, ws } = connected();

    const lateHandler = vi.fn();

    // firstHandler is the only 'm' listener when the first message arrives,
    // so dispatchToHandlers iterates the live Set (size === 1, no snapshot).
    // Inside the loop it calls socket.on('m', lateHandler), which mutates that
    // same Set. The bug causes lateHandler to be called for the triggering message.
    socket.on('message', () => {
      socket.on('message', lateHandler);
    });

    // First message: lateHandler is registered DURING dispatch of this message.
    // Correct behavior: lateHandler must NOT be called for this message.
    ws.emit({ event: 'message', payload: { text: 'first' } });

    expect(lateHandler).not.toHaveBeenCalled();

    // Second message: now lateHandler is already registered, so it must fire.
    ws.emit({ event: 'message', payload: { text: 'second' } });

    expect(lateHandler).toHaveBeenCalledTimes(1);
    expect(lateHandler).toHaveBeenCalledWith({ text: 'second' });
  });
});
