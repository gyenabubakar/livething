import { createServer } from 'node:http';
import { createHttpHub } from '@livething/server/adapters';
import { describe, expect, it } from 'vitest';
import { createNodeHttpHandler } from './http.ts';

describe('the Node http stream request', () => {
  it('rejects and ends the response when attach throws', async () => {
    const handle = createNodeHttpHandler({
      hub: createHttpHub({ maxPostBytes: 1024, receiveBytes: 4096 }),
      originAllowed: () => true,
      authenticate: async () => ({}),
      attach() {
        throw new Error('engine is shutting down');
      },
      shutdownSignal: new AbortController().signal,
    });
    const errors: unknown[] = [];
    const http = createServer((request, response) => {
      handle(request, response).catch((error: unknown) => errors.push(error));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as { port: number };

    const answer = await fetch(`http://127.0.0.1:${port}/huddle`, {
      headers: { Accept: 'text/event-stream', 'LiveThing-Protocol': 'livething-v1' },
    })
      .then((response) => response.text())
      .catch((error: unknown) => error);

    expect(answer).toBeInstanceOf(Error);
    expect(String(errors[0])).toMatch(/engine is shutting down/);
    await new Promise((resolve) => http.close(resolve));
  });

  // H3 v1 and other frameworks do not end open responses at shutdown, so the handler must.
  it('answers 503 when the endpoint shuts down during an authenticate that never ends', async () => {
    const shutdown = new AbortController();
    const handle = createNodeHttpHandler({
      hub: createHttpHub({ maxPostBytes: 1024, receiveBytes: 4096 }),
      originAllowed: () => true,
      authenticate: () => new Promise(() => {}),
      attach() {
        throw new Error('not reached');
      },
      shutdownSignal: shutdown.signal,
    });
    const http = createServer((request, response) => void handle(request, response));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as { port: number };

    const answer = fetch(`http://127.0.0.1:${port}/huddle`, {
      headers: { Accept: 'text/event-stream', 'LiveThing-Protocol': 'livething-v1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    shutdown.abort();

    const response = await answer;
    expect(response.status).toBe(503);
    expect(response.headers.get('LiveThing-Error')).toBe('shutting-down');
    await new Promise((resolve) => http.close(resolve));
  });
});
