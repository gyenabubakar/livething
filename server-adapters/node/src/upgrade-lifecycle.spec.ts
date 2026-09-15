import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { createUpgradeLifecycle } from './upgrade-lifecycle.ts';

function createRequest(): { request: IncomingMessage; socket: EventEmitter } {
  const socket = new EventEmitter();
  const request = Object.assign(new EventEmitter(), { socket }) as unknown as IncomingMessage;

  return { request, socket };
}

describe('upgrade lifecycle', () => {
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
