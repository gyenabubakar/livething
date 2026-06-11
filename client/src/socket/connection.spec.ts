import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { query } from '~/primitives/query.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const c = client();

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
  vi.useRealTimers();
});

describe('url-as-function / async url resolution', () => {
  it('calls the url function and connects to the resolved address', async () => {
    const urlFn = vi.fn().mockResolvedValue('wss://resolved-host/ws');
    const socket = c(connect(urlFn));
    socket.connect();
    // The async resolution must complete before the ws is created.
    await Promise.resolve();
    expect(urlFn).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.last().url).toBe('wss://resolved-host/ws');
  });

  it('connects to the resolved address when the url function returns a plain string (resolved via one microtask)', async () => {
    const urlFn = vi.fn().mockReturnValue('wss://sync/ws');
    const socket = c(connect(urlFn));
    socket.connect();
    await Promise.resolve();
    expect(MockWebSocket.last().url).toBe('wss://sync/ws');
  });

  it('cancels the open when disconnect() bumps attemptId before the async url resolves', async () => {
    let resolveUrl!: (url: string) => void;
    function urlFn() {
      return new Promise<string>((resolve) => {
        resolveUrl = resolve;
      });
    }

    const socket = c(connect(urlFn));
    socket.connect();
    socket.disconnect(); // bumps attemptId before url resolves

    resolveUrl('wss://too-late/ws');
    await Promise.resolve();

    expect(MockWebSocket.instances).toHaveLength(0); // attempt was cancelled
    expect(socket.getState()).toBe('closed');
  });
});

describe('stale-attempt onopen closes the superseded socket', () => {
  // This scenario works with a synchronous url:
  // 1. connect() creates a WebSocket (synchronous, no await needed for url)
  // 2. disconnect() bumps _connectAttemptId BEFORE onopen fires
  //    (this.ws is still null so disconnect() does NOT null ws handlers)
  // 3. ws.open() fires → onopen sees stale attemptId → calls ws.close()
  it('calls close() on the stale ws when disconnect() bumps attemptId before onopen fires', () => {
    const socket = c(connect('wss://host/ws'));
    const onOpen = vi.fn();
    socket.onOpen(onOpen);

    socket.connect(); // creates ws (attemptId=1)
    const ws = MockWebSocket.last();

    // Bump attemptId before onopen fires.
    socket.disconnect(); // _connectAttemptId → 2; this.ws is null so handlers stay
    expect(ws.onopen).not.toBeNull(); // handler is still attached

    // Simulate the network opening the stale socket.
    ws.open();

    expect(ws.readyState).toBe(3); // kernel called ws.close()
    expect(onOpen).not.toHaveBeenCalled();
    // The stale ws must not be stored as this.ws.
    expect(socket['ws']).toBeNull();
    // State must not have jumped to 'open'.
    expect(socket.getState()).toBe('closed');
  });

  it('does not fire onOpen or set state to open for a superseded onopen', () => {
    const socket = c(connect('wss://host/ws'));
    const onOpen = vi.fn();
    socket.onOpen(onOpen);

    // Attempt 1: connect, disconnect before open fires.
    socket.connect();
    const ws1 = MockWebSocket.last();
    socket.disconnect(); // attempt 1 is stale (attemptId=1 < _connectAttemptId=2)

    // Attempt 2: fresh connect.
    socket.connect();
    const ws2 = MockWebSocket.last();

    // Fire stale open first.
    ws1.open();
    expect(onOpen).not.toHaveBeenCalled();
    expect(socket.getState()).toBe('connecting'); // still waiting for attempt 2

    // Now the live attempt opens.
    ws2.open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(socket.getState()).toBe('open');
    expect(socket['ws']).toBe(ws2);
  });
});

describe('stale-attempt onclose is a no-op', () => {
  // These tests use reconnection() so that an unexpected drop triggers reopen()
  // directly — without nulling the old ws handlers — which is the only way to
  // reach the attemptId guard at socket.ts:496.
  // disconnect() would null ws.onclose first, so the guard would never be reached.

  it('does not null this.ws or fire user close when an old socket fires onclose', () => {
    vi.useFakeTimers();

    const socket = c(connect('wss://host/ws'), reconnection());
    const onClose = vi.fn();
    socket.onClose(onClose);

    // Attempt 1: connect and open.
    socket.connect();
    const ws1 = MockWebSocket.instances[0]!;
    expect(ws1.onclose).not.toBeNull(); // handler attached
    ws1.open();
    expect(socket.getState()).toBe('open');

    // An unexpected server drop triggers reconnection. ws1.onclose handler is
    // still attached (no disconnect() was called) — attemptId will be bumped by
    // the next _openConnection() call scheduled via the reconnection timer.
    ws1.serverClose(1006, 'server restart');
    // reconnection sets state to reconnecting and schedules a timer
    expect(socket.getState()).toBe('reconnecting');

    const closeCallsBefore = onClose.mock.calls.length;

    // Fire the reconnection timer → _openConnection bumps attemptId → ws2 created.
    vi.runAllTimers();
    const ws2 = MockWebSocket.instances[1]!;
    ws2.open(); // attempt 2 is now the live socket
    expect(socket.getState()).toBe('open');
    expect(socket['ws']).toBe(ws2);

    // ws1 still has its onclose attached (socket.ts:496 guard is the only thing
    // stopping this from clobbering ws2).
    expect(ws1.onclose).not.toBeNull();

    // Firing ws1.onclose again must be a no-op: the guard returns early.
    ws1.serverClose(1006, 'late duplicate');

    expect(socket.getState()).toBe('open');
    expect(socket['ws']).toBe(ws2);
    expect(onClose).toHaveBeenCalledTimes(closeCallsBefore);
  });

  it('does not clobber this.ws or state when stale onclose fires after live reconnect', () => {
    vi.useFakeTimers();

    const socket = c(connect('wss://host/ws'), reconnection());

    // Attempt 1: connect and open.
    socket.connect();
    const ws1 = MockWebSocket.instances[0]!;
    ws1.open();
    expect(socket.getState()).toBe('open');
    expect(socket['ws']).toBe(ws1);

    // Unexpected drop → reconnection timer scheduled; ws1 handlers stay attached.
    ws1.serverClose(1001, 'going away');
    expect(socket.getState()).toBe('reconnecting');

    // Advance timer → attempt 2 starts → ws2 opens.
    vi.runAllTimers();
    const ws2 = MockWebSocket.instances[1]!;
    ws2.open();

    expect(socket['ws']).toBe(ws2);
    expect(socket.getState()).toBe('open');

    // ws1 still has its onclose handler. Firing it now hits the attemptId guard
    // (socket.ts:496) and must leave ws2 and state untouched.
    expect(ws1.onclose).not.toBeNull();
    ws1.serverClose(1001, 'going away');

    expect(socket['ws']).toBe(ws2);
    expect(socket.getState()).toBe('open');
  });
});

describe('connect-failed catch — reconnection handoff', () => {
  it('hands off to reconnection (state → reconnecting) when url function throws', async () => {
    const urlFn = vi.fn().mockRejectedValue(new Error('DNS failed'));
    const socket = c(connect(urlFn), reconnection());
    socket.connect();
    await Promise.resolve();
    // The rejection should have been caught and handed to the unexpected-close handler.
    expect(socket.getState()).toBe('reconnecting');
  });

  it('goes to closed (no reconnection) when url function throws', async () => {
    const urlFn = vi.fn().mockRejectedValue(new Error('DNS failed'));
    const socket = c(connect(urlFn)); // no reconnection
    socket.connect();
    await Promise.resolve();
    expect(socket.getState()).toBe('closed');
  });

  it('hands off to reconnection when searchParams function rejects', async () => {
    const socket = c(
      connect('wss://host/ws'),
      query(() => Promise.reject(new Error('token error'))),
      reconnection(),
    );
    socket.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.getState()).toBe('reconnecting');
  });

  it('goes to closed when searchParams rejects and no reconnection is installed', async () => {
    const socket = c(
      connect('wss://host/ws'),
      query(() => Promise.reject(new Error('token error'))),
    );
    socket.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.getState()).toBe('closed');
  });

  it('is a no-op when disconnect() cancels the attempt before the catch runs', async () => {
    let rejectUrl!: (err: Error) => void;
    function urlFn() {
      return new Promise<string>((_, reject) => {
        rejectUrl = reject;
      });
    }

    const socket = c(connect(urlFn));
    socket.connect();
    socket.disconnect(); // cancels the attempt (bumps attemptId)

    rejectUrl(new Error('never'));
    await Promise.resolve();

    // Stale catch must be a no-op: socket stays closed (set by disconnect, not re-set).
    expect(socket.getState()).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

describe('url-function rejection fires close event (no reconnection)', () => {
  it('onClose fires when url function rejects and no reconnection is present', async () => {
    const urlFn = vi.fn().mockRejectedValue(new Error('DNS failed'));
    const socket = c(connect(urlFn));
    const onClose = vi.fn();
    socket.onClose(onClose);

    socket.connect();
    await Promise.resolve();

    // State goes to 'closed' (existing behaviour) — that part is fine.
    expect(socket.getState()).toBe('closed');
    // BUG: the catch path calls _setState('closed') but never emits 'close'.
    // Correct behaviour: onClose must fire so callers know the attempt ended.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('url-function rejection surfaces error event (with reconnection)', () => {
  it('onError fires when url function rejects and reconnection is present', async () => {
    const urlFn = vi.fn().mockRejectedValue(new Error('DNS failed'));
    const socket = c(connect(urlFn), reconnection());
    const onError = vi.fn();
    socket.onError(onError);

    socket.connect();
    await Promise.resolve();

    // State goes to 'reconnecting' (existing behaviour) — the reconnection handoff works.
    expect(socket.getState()).toBe('reconnecting');
    // BUG: the catch path forwards (1006, 'connection failed') to the unexpectedCloseHandler
    // and retries silently — the real Error is never surfaced via an 'error' event.
    // Correct behaviour: an error event must be emitted so the caller sees what failed.
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('disconnect() mid-first-hook skips second onBeforeReopen', () => {
  it('second primitive onBeforeReopen does not run when disconnect() fires during first hook', async () => {
    vi.useFakeTimers();

    let resolveFirst!: () => void;
    const firstHookDone = vi.fn();
    const secondHookRan = vi.fn();

    const primitive1 = {
      _tag: 'test-p1' as const,
      setup() {
        return {
          id: 'test-p1',
          onBeforeReopen() {
            return new Promise<void>((resolve) => {
              resolveFirst = () => {
                firstHookDone();
                resolve();
              };
            });
          },
        };
      },
    };

    const primitive2 = {
      _tag: 'test-p2' as const,
      setup() {
        return {
          id: 'test-p2',
          onBeforeReopen() {
            secondHookRan();
          },
        };
      },
    };

    const socket = c(
      connect('wss://host/ws'),
      reconnection(),
      primitive1 as any,
      primitive2 as any,
    );

    // First connect + open to make _isFirstConnect = false.
    socket.connect();
    MockWebSocket.last().open();
    expect(socket.getState()).toBe('open');

    // Trigger an unexpected drop so reconnection schedules a reopen.
    MockWebSocket.last().serverClose(1006, 'drop');
    expect(socket.getState()).toBe('reconnecting');

    // Fire the reconnection timer so _openConnection is called (starts onBeforeReopen loop).
    vi.runAllTimers();

    // At this point the first primitive's onBeforeReopen is pending (resolveFirst not called yet).
    // Disconnect now — this bumps _connectAttemptId so the reopen is stale.
    socket.disconnect();

    // Now resolve the first hook — the loop continues past it.
    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();

    // BUG: the cancel check only runs AFTER the whole onBeforeReopen loop finishes,
    // so the second primitive's hook has already run.
    // Correct behaviour: once disconnect() is detected, the second hook must NOT run.
    expect(secondHookRan).not.toHaveBeenCalled();
  });
});

describe('ws.onerror reaches onError as a raw Event', () => {
  it('delivers the raw error event to an onError handler when the socket is live', () => {
    const socket = c(connect('wss://host/ws'));
    const onError = vi.fn();
    socket.onError(onError);

    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const fakeEvent = { type: 'error', target: ws };
    ws.onerror?.(fakeEvent);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(fakeEvent);
  });

  it('passes the exact event object reference (not a wrapper) to onError', () => {
    const socket = c(connect('wss://host/ws'));
    let received: unknown;
    socket.onError((err: unknown) => {
      received = err;
    });

    socket.connect();
    const ws = MockWebSocket.last();
    ws.open();

    const fakeEvent = { type: 'error' };
    ws.onerror?.(fakeEvent);

    expect(received).toBe(fakeEvent);
  });
});

describe('searchParams URL separator', () => {
  it("appends with '?' when the base url has no query string", async () => {
    const socket = c(
      connect('wss://host/ws'),
      query(() => ({ token: 'abc' })),
    );
    socket.connect();
    await Promise.resolve();
    expect(MockWebSocket.last().url).toBe('wss://host/ws?token=abc');
  });

  it("appends with '&' when the base url already contains a query string", async () => {
    const socket = c(
      connect('wss://host/ws?version=2'),
      query(() => ({ token: 'abc' })),
    );
    socket.connect();
    await Promise.resolve();
    expect(MockWebSocket.last().url).toBe('wss://host/ws?version=2&token=abc');
  });

  it('does not add any separator when searchParams returns an empty object', async () => {
    const socket = c(
      connect('wss://host/ws?version=2'),
      query(() => ({})),
    );
    socket.connect();
    await Promise.resolve();
    expect(MockWebSocket.last().url).toBe('wss://host/ws?version=2');
  });

  it("uses '&' with an async url function that resolves to a url with a query string", async () => {
    const urlFn = vi.fn().mockResolvedValue('wss://host/ws?env=prod');
    const socket = c(
      connect(urlFn),
      query(() => ({ token: 'xyz' })),
    );
    socket.connect();
    await Promise.resolve();
    await Promise.resolve(); // one tick for urlFn, one for searchParams
    expect(MockWebSocket.last().url).toBe('wss://host/ws?env=prod&token=xyz');
  });
});

describe('query() re-resolves on reconnect (auth token refresh)', () => {
  it('sends the freshly resolved token on the reconnect attempt, not the stale one', async () => {
    vi.useFakeTimers();
    let token = 'first';
    const socket = c(
      connect('wss://host/ws'),
      query(() => ({ token })),
      reconnection({ maxAttempts: 1 }),
    );

    socket.connect();
    await vi.advanceTimersByTimeAsync(0); // flush async url + searchParams resolution
    expect(MockWebSocket.last().url).toBe('wss://host/ws?token=first');
    MockWebSocket.last().open();

    // Rotate the token, then force an unexpected drop so reconnection retries.
    token = 'second';
    MockWebSocket.last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(2000); // fire the retry + re-resolve query()

    // The reconnect picked up the new token — proving query() runs on every
    // open, not just the first connect.
    expect(MockWebSocket.last().url).toBe('wss://host/ws?token=second');
  });
});
