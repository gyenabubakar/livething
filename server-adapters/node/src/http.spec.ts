import { createServer } from 'node:http';
import { createHttpHub } from '@livething/server/adapters';
import { describe, expect, it } from 'vitest';
import type { ConnectionHandle } from '@livething/server/adapters';
import { createNodeHttpHandler } from './http.ts';
import type { ConnectionTransport } from './socket.ts';

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

  it('sends the events of one event loop turn as one write, and counts them as buffered', async () => {
    let transport: ConnectionTransport | undefined;
    const handle = createNodeHttpHandler({
      hub: createHttpHub({ maxPostBytes: 1024, receiveBytes: 4096 }),
      originAllowed: () => true,
      authenticate: async () => ({}),
      attach(opened) {
        transport = opened;
        return { handleClose: async () => {} } as unknown as ConnectionHandle;
      },
      shutdownSignal: new AbortController().signal,
    });

    const writes: string[] = [];
    const http = createServer((request, response) => {
      const write = response.write.bind(response) as (chunk: Uint8Array) => boolean;
      response.write = ((chunk: Uint8Array) => {
        writes.push(Buffer.from(chunk).toString());
        return write(chunk);
      }) as typeof response.write;
      void handle(request, response);
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as { port: number };

    const response = await fetch(`http://127.0.0.1:${port}/huddle`, {
      headers: { Accept: 'text/event-stream', 'LiveThing-Protocol': 'livething-v1' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const before = writes.length;

    transport!.send({ kind: 'text', text: '"first"' });
    transport!.send({ kind: 'text', text: '"second"' });
    expect(writes.length).toBe(before);
    expect(transport!.bufferedAmount()).toBeGreaterThanOrEqual(31);

    await new Promise((resolve) => setImmediate(resolve));
    expect(writes.slice(before)).toEqual(['data: "first"\n\ndata: "second"\n\n']);

    transport!.close(1000, 'done');
    expect(await response.text()).toContain('data: "first"\n\ndata: "second"\n\n');
    await new Promise((resolve) => http.close(resolve));
  });

  it('sends big events as their own writes, in order, and 64 KiB of them at once', async () => {
    let transport: ConnectionTransport | undefined;
    const handle = createNodeHttpHandler({
      hub: createHttpHub({ maxPostBytes: 1024, receiveBytes: 4096 }),
      originAllowed: () => true,
      authenticate: async () => ({}),
      attach(opened) {
        transport = opened;
        return { handleClose: async () => {} } as unknown as ConnectionHandle;
      },
      shutdownSignal: new AbortController().signal,
    });

    const writes: string[] = [];
    const http = createServer((request, response) => {
      const write = response.write.bind(response) as (chunk: Uint8Array) => boolean;
      response.write = ((chunk: Uint8Array) => {
        writes.push(Buffer.from(chunk).toString());
        return write(chunk);
      }) as typeof response.write;
      void handle(request, response);
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as { port: number };

    const response = await fetch(`http://127.0.0.1:${port}/huddle`, {
      headers: { Accept: 'text/event-stream', 'LiveThing-Protocol': 'livething-v1' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const before = writes.length;
    function big(letter: string, length: number): string {
      return `"${letter.repeat(length)}"`;
    }

    transport!.send({ kind: 'text', text: big('a', 2000) });
    transport!.send({ kind: 'text', text: big('b', 2000) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(writes.slice(before)).toEqual([
      `data: ${big('a', 2000)}\n\n`,
      `data: ${big('b', 2000)}\n\n`,
    ]);

    const held = writes.length;
    transport!.send({ kind: 'text', text: big('c', 70_000) });
    expect(writes.length).toBe(held + 1);

    transport!.close(1000, 'done');
    const text = await response.text();
    expect(text.indexOf('aaa')).toBeLessThan(text.indexOf('bbb'));
    expect(text.indexOf('bbb')).toBeLessThan(text.indexOf('ccc'));
    await new Promise((resolve) => http.close(resolve));
  });
});
