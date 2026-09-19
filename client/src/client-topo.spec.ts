import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { dedup } from '~/primitives/dedup.ts';
import { intercept } from '~/primitives/intercept.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { replay } from '~/primitives/replay.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface C {
  incoming: { msg: { text: string } };
  outgoing: { chat: { text: string } };
}

interface ChannelContract {
  channels: {
    general: {
      incoming: { message: { text: string } };
      outgoing: { 'send-message': { text: string } };
    };
  };
}

// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- forward client()'s primitive constraint
function build<const P extends readonly Primitive<any, any>[]>(
  ...primitives: [...P] & ValidatePrimitives<C, P>
) {
  const socket = client<C>()(connect('wss://test'), ...primitives);
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  restore();
});

describe('topoSort — circular dependency detection', () => {
  it('throws "circular primitive dependency detected" when two primitives depend on each other', () => {
    const alpha = { _tag: 'alpha', dependencies: ['beta'] };
    const beta = { _tag: 'beta', dependencies: ['alpha'] };

    expect(() => {
      client<C>()(
        connect('wss://test'),
        alpha as unknown as Primitive,
        beta as unknown as Primitive,
      );
    }).toThrow(/circular primitive dependency detected/);
  });
});

describe('topoSort — dependency ordering', () => {
  it('places dedup before replay at runtime even when replay is passed first', () => {
    const { socket, ws } = build(replay(), dedup(), reconnection());

    const handler = vi.fn();
    socket.on('msg', handler);

    const first = {
      event: 'msg',
      payload: { text: 'hello' },
      metadata: { delivery: { id: 'id-1', seq: 5 } },
    };

    const dup = {
      event: 'msg',
      payload: { text: 'hello' },
      metadata: { delivery: { id: 'id-1', seq: 20 } },
    };

    ws.emit(first);
    expect(handler).toHaveBeenCalledTimes(1);

    ws.emit(dup);
    expect(handler).toHaveBeenCalledTimes(1);

    ws.serverClose(1006, 'dropped');
    vi.advanceTimersByTime(1500);
    const ws2 = MockWebSocket.last();
    ws2.open();

    // With correct ordering (dedup first), replay never saw the duplicate, so
    // lastKnownSeq must be 5. If it were 20 the sort was wrong.
    const replayFrame = ws2.sentFrames().find((f: { event: string }) => f.event === '__replay__');
    expect(replayFrame).toBeDefined();
    expect(replayFrame.payload.lastKnownSeq).toBe(5);
  });

  it('dedup onIncoming runs before replay onIncoming even when replay is registered first', () => {
    // We wire a spy that declares 'replay' as its dependency, forcing it to the
    // end of the sorted order: dedup → replay → spy.
    //
    // Registration order is deliberately reversed: replay(), spy (deps: ['replay']),
    // dedup() — so the pipeline is wrong unless topoSort fixes it.
    //
    // We send the same messageId twice but with a higher seq on the duplicate.
    // With correct ordering (dedup first):
    //   frame1 → dedup passes it → replay records seq 7 → spy records [7]
    //   dup   → dedup drops it  → replay never runs     → spy never runs → spySeen = [7]
    //
    // With wrong ordering (replay first):
    //   frame1 → replay records seq 7 → spy records [7] → dedup records 'id-x'
    //   dup    → replay records seq 99 (99 > 7) → spy records [7, 99] → dedup drops too late
    //   spySeen would be [7, 99] — the test would fail.
    const spySeen: number[] = [];

    const spy = {
      _tag: 'order-spy',
      dependencies: ['replay'],
      setup() {
        return {
          id: 'order-spy',
          onIncoming(message: {
            event: string;
            payload: unknown;
            metadata?: { delivery?: { seq?: number } };
          }) {
            spySeen.push(message.metadata?.delivery?.seq ?? -1);
            return message;
          },
        };
      },
    };

    const socket = client<C>()(
      connect('wss://test'),
      replay(),
      spy as unknown as Primitive,
      dedup(),
    );
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const handler = vi.fn();
    socket.on('msg', handler);

    const first = {
      event: 'msg',
      payload: { text: 'hi' },
      metadata: { delivery: { id: 'id-x', seq: 7 } },
    };

    const dup = {
      event: 'msg',
      payload: { text: 'hi' },
      metadata: { delivery: { id: 'id-x', seq: 99 } },
    };

    ws.emit(first);
    expect(spySeen).toEqual([7]);

    ws.emit(dup);
    expect(spySeen).toEqual([7]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('topoSort — optionalAfter ordering', () => {
  type TestSocket = {
    connect(): void;
    channel(name: string): { subscribe(): Promise<void> };
  };
  function subscribeThenReconnect(primitives: readonly Primitive[]): string[] {
    const build = client<ChannelContract>() as unknown as (
      c: ReturnType<typeof connect>,
      ...rest: readonly Primitive[]
    ) => TestSocket;
    const socket = build(connect('wss://test'), ...primitives);
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const room = socket.channel('general');
    void room.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });

    ws.emit({
      event: 'message',
      payload: { text: 'hi' },
      metadata: { channel: { name: 'general' }, delivery: { seq: 3, id: 'm-1' } },
    });

    ws.serverClose(1006, 'dropped');
    vi.advanceTimersByTime(1500);
    const ws2 = MockWebSocket.last();
    ws2.open();

    return ws2.sentFrames().map((f: { event: string }) => f.event);
  }

  it('sends channel __subscribe__ before __replay__ when channels is listed first', () => {
    const events = subscribeThenReconnect([channels(), dedup(), replay(), reconnection()]);
    const sub = events.indexOf('__subscribe__');
    const rep = events.indexOf('__replay__');
    expect(sub).toBeGreaterThanOrEqual(0);
    expect(rep).toBeGreaterThanOrEqual(0);

    expect(sub).toBeLessThan(rep);
  });

  it('sends channel __subscribe__ before __replay__ even when replay is listed first', () => {
    const events = subscribeThenReconnect([replay(), dedup(), channels(), reconnection()]);
    const sub = events.indexOf('__subscribe__');
    const rep = events.indexOf('__replay__');
    expect(sub).toBeGreaterThanOrEqual(0);
    expect(rep).toBeGreaterThanOrEqual(0);

    expect(sub).toBeLessThan(rep);
  });
});

describe('topoSort — intercept tag collision', () => {
  it('two intercepts keep original registration order (A before B) when a primitive with optionalAfter:[intercept] is listed first', () => {
    const runOrder: string[] = [];

    const interceptA = intercept(() => {
      runOrder.push('A');
    });
    const interceptB = intercept(() => {
      runOrder.push('B');
    });

    const primWithOptAfter = {
      _tag: 'order-probe',
      optionalAfter: ['intercept'],
    } satisfies Primitive;

    const socket = client<C>()(
      connect('wss://test'),
      primWithOptAfter as unknown as Primitive,
      interceptA,
      interceptB,
    );
    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    ws.emit({ event: 'msg', payload: { text: 'hello' } });

    // Correct behavior: A was registered first, so A must run before B.
    expect(runOrder).toEqual(['A', 'B']);
  });
});
