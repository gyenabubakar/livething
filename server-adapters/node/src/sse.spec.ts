import { createServer } from 'node:http';
import { createSseHub } from '@livething/server/adapters';
import { describe, expect, it } from 'vitest';
import { createNodeSseHandler } from './sse.ts';

describe('the Node SSE stream request', () => {
  it('rejects and ends the response when attach throws', async () => {
    const handle = createNodeSseHandler({
      hub: createSseHub({ maxPostBytes: 1024, receiveBytes: 4096 }),
      originAllowed: () => true,
      authenticate: async () => ({}),
      attach() {
        throw new Error('engine is shutting down');
      },
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
});
