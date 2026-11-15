import { server } from '@livething/server';
import { keepalive } from '@livething/server/keepalive';
import { describe, expect, it, vi } from 'vitest';
import type { ServerHttp2Stream } from 'node:http2';
import { StreamExchange } from './http2-stream.ts';
import { http } from './index.ts';
import { setup } from './setup.ts';

const huddleDefinition = server({
  authenticate: () => ({ userId: 'ada' }),
  capabilities: [keepalive()],
}).assemble({ handlers: [] });

function fakeStream({ reset = false } = {}) {
  return {
    session: reset ? undefined : { socket: {} },
    destroyed: false,
    closed: false,
    on: vi.fn(),
    respond: vi.fn(),
    destroy: vi.fn(),
  };
}

describe('StreamExchange', () => {
  it('drops the HTTP/1.1 connection headers that HTTP/2 refuses', () => {
    const stream = fakeStream();
    const exchange = new StreamExchange(stream as unknown as ServerHttp2Stream, {});

    exchange.writeHead(200, {
      'Content-Type': 'text/plain',
      Connection: 'keep-alive',
      'Keep-Alive': 'timeout=5',
      'Transfer-Encoding': 'chunked',
      TE: 'gzip',
    });

    expect(stream.respond).toHaveBeenCalledWith({ ':status': 200, 'Content-Type': 'text/plain' });
  });
});

describe('handleStream', () => {
  it('destroys a stream the client reset before it was handed over, and does not throw', async () => {
    const livething = setup();
    const huddleEndpoint = livething.bind(huddleDefinition, { transports: [http()] });
    const stream = fakeStream({ reset: true });

    expect(() =>
      huddleEndpoint.handleStream(stream as unknown as ServerHttp2Stream, { ':path': '/huddle' }),
    ).not.toThrow();
    expect(stream.destroy).toHaveBeenCalled();
    await livething.shutdown();
  });
});
