import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { dedup } from '~/primitives/dedup.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { replay } from '~/primitives/replay.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive, ValidatePrimitives } from '~/primitives/types.ts';

interface C {
  incoming: { msg: { text: string } };
  outgoing: { chat: { text: string } };
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
    // alpha depends on beta and beta depends on alpha — a cycle
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
    // replay() declares 'dedup' as a dependency, so topoSort must sort dedup
    // first even when the caller registers replay before dedup.
    //
    // Observable proof: send the same messageId twice but with a higher seq on
    // the duplicate. When dedup runs first it drops the duplicate before replay
    // ever sees it, so replay's high-water mark stays at the original seq (5).
    // If the order were wrong (replay before dedup), replay would update its
    // high-water mark to the duplicate's seq (20) before dedup drops the frame,
    // and on reconnect the __replay__ request would ask for seq after 20.
    const { socket, ws } = build(replay(), dedup(), reconnection());

    const handler = vi.fn();
    socket.on('msg', handler);

    const first = {
      event: 'msg',
      payload: { text: 'hello' },
      __wskit: { messageId: 'id-1', seq: 5 },
    };
    const dup = {
      event: 'msg',
      payload: { text: 'hello' },
      __wskit: { messageId: 'id-1', seq: 20 },
    };

    ws.emit(first);
    expect(handler).toHaveBeenCalledTimes(1);

    ws.emit(dup);
    expect(handler).toHaveBeenCalledTimes(1); // dedup swallowed the duplicate

    // Trigger reconnect so replay's onReconnect fires.
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
      dependencies: ['replay'], // must sort after replay; correct order: dedup → replay → spy
      setup() {
        return {
          id: 'order-spy',
          onIncoming(message: { event: string; payload: unknown; __wskit?: { seq?: number } }) {
            spySeen.push(message.__wskit?.seq ?? -1);
            return message;
          },
        };
      },
    };

    // Registration order: replay → spy → dedup (wrong without topoSort).
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

    const first = { event: 'msg', payload: { text: 'hi' }, __wskit: { messageId: 'id-x', seq: 7 } };
    const dup = { event: 'msg', payload: { text: 'hi' }, __wskit: { messageId: 'id-x', seq: 99 } };

    ws.emit(first);
    expect(spySeen).toEqual([7]); // spy saw the first delivery

    ws.emit(dup);
    // dedup (sorted first) dropped the duplicate before replay or spy ran.
    // If replay had run first, it would have updated lastSeq to 99 and the spy
    // would have recorded 99 here.
    expect(spySeen).toEqual([7]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
