import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { requestToWebRequest } from './request.ts';

function incomingRequest(
  values: Partial<Pick<IncomingMessage, 'url' | 'method' | 'headers'>> = {},
): IncomingMessage {
  const socket = new Socket();
  return Object.assign(new IncomingMessage(socket), {
    url: '/socket?room=one',
    method: 'GET',
    ...values,
    headers: {
      host: 'example.test',
      connection: 'Upgrade',
      upgrade: 'websocket',
      ...values.headers,
    },
  });
}

describe('requestToWebRequest', () => {
  it('preserves the URL, method, and headers', () => {
    const request = requestToWebRequest(
      incomingRequest({
        url: '/chat?room=one',
        method: 'GET',
        headers: { host: 'chat.example', authorization: 'Bearer token' },
      }),
    );

    expect(request.url).toBe('http://chat.example/chat?room=one');
    expect(request.method).toBe('GET');
    expect(request.headers.get('authorization')).toBe('Bearer token');
    expect(request.headers.get('upgrade')).toBe('websocket');
    expect(request.body).toBeNull();
  });

  it('keeps the Host header as the authority for a network-path request target', () => {
    const request = requestToWebRequest(
      incomingRequest({
        url: '//evil.example/chat',
        headers: { host: 'trusted.example' },
      }),
    );

    expect(request.url).toBe('http://trusted.example//evil.example/chat');
  });

  it.each(['/\\evil.example/chat', '/\\/evil.example/chat', 'http://evil.example/chat'])(
    'rejects a request target that can replace the Host authority: %s',
    (url) => {
      expect(() => requestToWebRequest(incomingRequest({ url }))).toThrow();
    },
  );

  it('accepts an absolute-form target when it matches Host', () => {
    const request = requestToWebRequest(
      incomingRequest({
        url: 'http://example.test/chat',
      }),
    );

    expect(request.url).toBe('http://example.test/chat');
  });

  it('preserves the supplied abort signal', () => {
    const controller = new AbortController();
    const request = requestToWebRequest(incomingRequest(), { signal: controller.signal });

    expect(request.signal.aborted).toBe(false);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  it('sets the adapter client IP and removes a client-supplied value', () => {
    const request = requestToWebRequest(
      incomingRequest({ headers: { 'WSKit-Client-IP': '198.51.100.99' } }),
      { clientIp: '203.0.113.7' },
    );

    expect(request.headers.get('WSKit-Client-IP')).toBe('203.0.113.7');

    const withoutClientIp = requestToWebRequest(
      incomingRequest({ headers: { 'WSKit-Client-IP': '198.51.100.99' } }),
    );

    expect(withoutClientIp.headers.get('WSKit-Client-IP')).toBeNull();
  });
});
