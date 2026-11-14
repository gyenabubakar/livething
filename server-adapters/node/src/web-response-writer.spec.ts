import { describe, expect, it } from 'vitest';
import { WebResponseWriter } from './web-response-writer.ts';

describe('WebResponseWriter', () => {
  it('passes bytes through as they are', async () => {
    const writer = new WebResponseWriter(new AbortController().signal);
    writer.writeHead(200, {});

    writer.write(new TextEncoder().encode('hi'));
    writer.write(' there');
    writer.end();

    expect(await (await writer.answer).text()).toBe('hi there');
  });

  it('keeps each Set-Cookie header apart', async () => {
    const writer = new WebResponseWriter(new AbortController().signal);

    writer.writeHead(204, { 'set-cookie': ['huddle_session=a1', 'huddle_theme=dark'] });

    expect((await writer.answer).headers.getSetCookie()).toEqual([
      'huddle_session=a1',
      'huddle_theme=dark',
    ]);
  });

  it('answers 503 when it is destroyed before its headers', async () => {
    const writer = new WebResponseWriter(new AbortController().signal);

    writer.destroy();

    expect((await writer.answer).status).toBe(503);
  });
});
