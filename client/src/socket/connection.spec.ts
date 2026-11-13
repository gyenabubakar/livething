import { LiveThingConfigError } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { reconnection } from '~/primitives/reconnection/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Primitive } from '~/primitives/types.ts';

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

  it('awaits a thenable that is not instanceof Promise (cross-realm)', async () => {
    const foreign = {
      then(onFulfilled: (value: string) => unknown) {
        return Promise.resolve(onFulfilled('wss://xrealm/ws'));
      },
    };

    expect(foreign instanceof Promise).toBe(false);

    const socket = c(connect(() => foreign as unknown as Promise<string>));
    socket.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(MockWebSocket.last().url).toBe('wss://xrealm/ws');
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
    socket.disconnect();

    resolveUrl('wss://too-late/ws');
    await Promise.resolve();

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(socket.state.get()).toBe('closed');
  });
});

describe('a superseded socket', () => {
  it('is closed at once when disconnect() runs while it is still connecting', () => {
    const socket = c(connect('wss://host/ws'));
    const onOpen = vi.fn();
    socket.onOpen(onOpen);

    socket.connect();
    const ws = MockWebSocket.last();

    socket.disconnect();
    expect(ws.readyState).toBe(3);
    expect(ws.onopen).toBeNull();

    ws.open();

    expect(onOpen).not.toHaveBeenCalled();
    expect(socket['ws']).toBeNull();
    expect(socket.state.get()).toBe('closed');
  });

  it('does not fire onOpen or set state to open for a superseded onopen', () => {
    const socket = c(connect('wss://host/ws'));
    const onOpen = vi.fn();
    socket.onOpen(onOpen);

    socket.connect();
    const ws1 = MockWebSocket.last();
    socket.disconnect();

    socket.connect();
    const ws2 = MockWebSocket.last();

    ws1.open();
    expect(onOpen).not.toHaveBeenCalled();
    expect(socket.state.get()).toBe('connecting');

    ws2.open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(socket.state.get()).toBe('open');
    expect(socket['ws']).toBe(ws2);
  });
});

describe('stale-attempt onclose is a no-op', () => {
  // These tests use reconnection() so that an unexpected drop triggers reopen()
  // directly — without nulling the old ws handlers — which is the only way to
  // reach the guard that ignores events from a transport that is not the current one.
  // disconnect() would null ws.onclose first, so the guard would never be reached.
  // Each wait is past the backoff and short of the 30 s connect timeout.

  it('does not null this.ws or fire user close when an old socket fires onclose', () => {
    vi.useFakeTimers();

    const socket = c(connect('wss://host/ws'), reconnection());
    const onClose = vi.fn();
    socket.onClose(onClose);

    socket.connect();
    const ws1 = MockWebSocket.instances[0]!;
    expect(ws1.onclose).not.toBeNull();
    ws1.open();
    expect(socket.state.get()).toBe('open');

    ws1.serverClose(1006, 'server restart');
    expect(socket.state.get()).toBe('reconnecting');

    const closeCallsBefore = onClose.mock.calls.length;

    vi.advanceTimersByTime(5_000);
    const ws2 = MockWebSocket.instances[1]!;
    ws2.open();
    expect(socket.state.get()).toBe('open');
    expect(socket['ws']).toBe(ws2);

    // ws1 still has its onclose attached (the current-transport guard is the only thing
    // stopping this from clobbering ws2).
    expect(ws1.onclose).not.toBeNull();

    // Firing ws1.onclose again must be a no-op: the guard returns early.
    ws1.serverClose(1006, 'late duplicate');

    expect(socket.state.get()).toBe('open');
    expect(socket['ws']).toBe(ws2);
    expect(onClose).toHaveBeenCalledTimes(closeCallsBefore);
  });

  it('does not clobber this.ws or state when stale onclose fires after live reconnect', () => {
    vi.useFakeTimers();

    const socket = c(connect('wss://host/ws'), reconnection());

    socket.connect();
    const ws1 = MockWebSocket.instances[0]!;
    ws1.open();
    expect(socket.state.get()).toBe('open');
    expect(socket['ws']).toBe(ws1);

    ws1.serverClose(1001, 'going away');
    expect(socket.state.get()).toBe('reconnecting');

    vi.advanceTimersByTime(5_000);
    const ws2 = MockWebSocket.instances[1]!;
    ws2.open();

    expect(socket['ws']).toBe(ws2);
    expect(socket.state.get()).toBe('open');

    // ws1 still has its onclose handler. Firing it now hits the current-transport guard
    // and must leave ws2 and state untouched.
    expect(ws1.onclose).not.toBeNull();
    ws1.serverClose(1001, 'going away');

    expect(socket['ws']).toBe(ws2);
    expect(socket.state.get()).toBe('open');
  });
});

describe('connect-failed catch — reconnection handoff', () => {
  it('rethrows a rejected connection URL when no error listener is registered', async () => {
    const thrown = new Promise<unknown>((resolve) => {
      process.setUncaughtExceptionCaptureCallback(resolve);
    });
    const socket = c(connect(() => Promise.reject(new Error('DNS failed'))));

    try {
      socket.connect();
      await expect(thrown).resolves.toMatchObject({ message: 'DNS failed' });
    } finally {
      process.setUncaughtExceptionCaptureCallback(null);
    }
  });

  it('hands off to reconnection (state → reconnecting) when url function throws', async () => {
    const urlFn = vi.fn().mockRejectedValue(new Error('DNS failed'));
    const socket = c(connect(urlFn), reconnection());
    socket.onError(() => undefined);
    socket.connect();
    await Promise.resolve();

    expect(socket.state.get()).toBe('reconnecting');
  });

  it('goes to closed (no reconnection) when url function throws', async () => {
    const urlFn = vi.fn().mockRejectedValue(new Error('DNS failed'));
    const socket = c(connect(urlFn));
    socket.onError(() => undefined);
    socket.connect();
    await Promise.resolve();

    expect(socket.state.get()).toBe('closed');
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
    socket.disconnect();

    rejectUrl(new Error('never'));
    await Promise.resolve();

    expect(socket.state.get()).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

describe('url-function rejection fires close event (no reconnection)', () => {
  it('onClose fires when url function rejects and no reconnection is present', async () => {
    const urlFn = vi.fn().mockRejectedValue(new Error('DNS failed'));
    const socket = c(connect(urlFn));
    const onClose = vi.fn();
    socket.onError(() => undefined);
    socket.onClose(onClose);

    socket.connect();
    await Promise.resolve();

    expect(socket.state.get()).toBe('closed');
    // onClose must fire so callers know the attempt ended.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('a connect attempt that fails before the socket exists fires onClose', () => {
  const failed = { code: 1006, reason: 'connection failed', wasClean: false };

  it('fires onClose once with reconnection() when the url function rejects', async () => {
    const urlFn = vi.fn().mockRejectedValue(new Error('DNS failed'));
    const socket = c(connect(urlFn), reconnection());
    const onClose = vi.fn();
    const statesSeen: string[] = [];
    socket.onError(() => undefined);

    socket.onClose((event) => {
      statesSeen.push(socket.state.get());
      onClose(event);
    });

    socket.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(failed);
    expect(statesSeen).toEqual(['reconnecting']);
  });

  it('fires onClose once with reconnection() when the url function throws', async () => {
    const socket = c(
      connect(() => {
        throw new Error('no token');
      }),
      reconnection(),
    );
    const onClose = vi.fn();
    socket.onError(() => undefined);
    socket.onClose(onClose);

    socket.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.state.get()).toBe('reconnecting');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(failed);
  });

  it('gives the same close event with and without reconnection()', async () => {
    const withoutReconnection = c(connect(vi.fn().mockRejectedValue(new Error('DNS failed'))));
    const withReconnection = c(
      connect(vi.fn().mockRejectedValue(new Error('DNS failed'))),
      reconnection(),
    );
    const plainClose = vi.fn();
    const retryClose = vi.fn();
    withoutReconnection.onError(() => undefined);

    withReconnection.onError(() => undefined);
    withoutReconnection.onClose(plainClose);
    withReconnection.onClose(retryClose);

    withoutReconnection.connect();
    withReconnection.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(plainClose.mock.calls).toEqual([[failed]]);
    expect(retryClose.mock.calls).toEqual(plainClose.mock.calls);
  });
});

describe('failed first connection runs primitive close cleanup', () => {
  it('runs primitive onClose even when reconnection takes over', async () => {
    const onClose = vi.fn();
    const probe = {
      _tag: 'probe',
      setup: () => ({ id: 'probe', onClose }),
    } as unknown as Primitive;
    const urlFn = vi.fn().mockRejectedValue(new Error('DNS failed'));
    const socket = c(connect(urlFn), reconnection(), probe);
    socket.onError(() => undefined);

    socket.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.state.get()).toBe('reconnecting');
    expect(onClose).toHaveBeenCalledWith(1006, 'connection failed', false, false);
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

    expect(socket.state.get()).toBe('reconnecting');
    // An error event must be emitted so the caller sees what failed.
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
      primitive1 as unknown as Primitive,
      primitive2 as unknown as Primitive,
    );

    socket.connect();
    MockWebSocket.last().open();
    expect(socket.state.get()).toBe('open');

    MockWebSocket.last().serverClose(1006, 'drop');
    expect(socket.state.get()).toBe('reconnecting');

    vi.runAllTimers();

    socket.disconnect();

    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();

    // Once disconnect() is detected, the second hook must NOT run.
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

describe('the url function runs again on reconnect (auth token refresh)', () => {
  it('sends the freshly resolved token on the reconnect attempt, not the stale one', async () => {
    vi.useFakeTimers();
    let token = 'first';
    const socket = c(
      connect(async () => `wss://host/ws?${new URLSearchParams({ token })}`),
      reconnection({ maxAttempts: 1 }),
    );

    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(MockWebSocket.last().url).toBe('wss://host/ws?token=first');
    MockWebSocket.last().open();

    token = 'second';
    MockWebSocket.last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(2000);

    expect(MockWebSocket.last().url).toBe('wss://host/ws?token=second');
  });
});

describe('a url function that returns a non-string', () => {
  it('reports its config error once and does not retry', async () => {
    vi.useFakeTimers();
    const urlFn = vi.fn(() => undefined as unknown as string);
    const socket = c(connect(urlFn), reconnection());
    const errors: unknown[] = [];
    socket.onError((error) => errors.push(error));

    socket.connect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(urlFn).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(LiveThingConfigError);
    expect(socket.state.get()).toBe('closed');
    expect(socket.reconnection.get().retrying).toBe(false);
  });

  it('stops the retry loop when it starts returning a non-string on a reconnect', async () => {
    vi.useFakeTimers();
    let url: unknown = 'wss://host/ws';
    const urlFn = vi.fn(() => url as string);
    const socket = c(connect(urlFn), reconnection());
    const errors: unknown[] = [];

    socket.onError((error) => errors.push(error));

    socket.connect();
    await vi.advanceTimersByTimeAsync(0);
    MockWebSocket.last().open();
    url = 42;
    MockWebSocket.last().serverClose(1006);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(urlFn).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(socket.state.get()).toBe('closed');
    expect(socket.reconnection.get().retrying).toBe(false);
  });

  it('still retries when the url function throws its own config error', async () => {
    vi.useFakeTimers();
    const urlFn = vi.fn(() => {
      throw new LiveThingConfigError('token settings are wrong');
    });
    const socket = c(connect(urlFn), reconnection({ maxAttempts: 2 }));
    socket.onError(() => undefined);

    socket.connect();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(urlFn).toHaveBeenCalledTimes(3);
  });
});
