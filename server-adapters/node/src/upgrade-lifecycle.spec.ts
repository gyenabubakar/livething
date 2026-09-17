import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { createUpgradeLifecycle } from './upgrade-lifecycle.ts';

function createRequest(): { request: IncomingMessage; socket: EventEmitter } {
  const socket = new EventEmitter();
  const request = Object.assign(new EventEmitter(), { socket }) as unknown as IncomingMessage;

  return { request, socket };
}

describe('upgrade lifecycle', () => {
  it('waits for preparation that starts shutdown synchronously', async () => {
    const lifecycle = createUpgradeLifecycle();
    const { request } = createRequest();
    const shutdown = vi.fn(async () => {});
    let release!: (value: string) => void;
    let stopping!: Promise<void>;

    const preparation = lifecycle.prepare(request, () => {
      stopping = lifecycle.shutdown(shutdown);
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();

    release('accepted');
    await expect(preparation).resolves.toBeUndefined();
    await stopping;
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('cancels preparation when the socket already ended', async () => {
    const lifecycle = createUpgradeLifecycle();
    const { request, socket } = createRequest();
    Object.assign(socket, { readableEnded: true });
    let aborted = false;

    const result = lifecycle.prepare(request, async (signal) => {
      aborted = signal.aborted;
      return 'accepted';
    });

    await expect(result).resolves.toBeUndefined();
    expect(aborted).toBe(true);
  });

  it.each(['end', 'error'] as const)(
    'cancels preparation when the socket emits %s',
    async (event) => {
      const lifecycle = createUpgradeLifecycle();
      const { request, socket } = createRequest();
      let release!: (value: string) => void;
      let aborted = false;
      const result = lifecycle.prepare(
        request,
        (signal) =>
          new Promise<string>((resolve) => {
            release = resolve;
            signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
      );

      if (event === 'error') socket.emit(event, new Error('connection reset'));
      else socket.emit(event);
      release('accepted');

      await expect(result).resolves.toBeUndefined();
      expect(aborted).toBe(true);
    },
  );
});
