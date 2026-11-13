import { describe, expect, it } from 'vitest';
import { createOriginCheck } from './origin.ts';

function request(url: string, headers: Record<string, string>): Request {
  return new Request(url, { headers });
}

describe('createOriginCheck', () => {
  const sameOrigin = createOriginCheck();

  it('allows a request with no Origin header', () => {
    expect(sameOrigin(request('https://huddle.test/huddle', { host: 'huddle.test' }))).toBe(true);
  });

  it('allows an Origin whose host and port match Host', () => {
    expect(
      sameOrigin(
        request('http://localhost:3000/huddle', {
          host: 'localhost:3000',
          origin: 'http://localhost:3000',
        }),
      ),
    ).toBe(true);
  });

  it('does not compare the scheme, because a TLS proxy hides it', () => {
    expect(
      sameOrigin(
        request('http://huddle.test/huddle', {
          host: 'huddle.test',
          origin: 'https://huddle.test',
        }),
      ),
    ).toBe(true);
  });

  it('matches a Host with no port against the default port of the Origin', () => {
    expect(
      sameOrigin(
        request('https://huddle.test/huddle', {
          host: 'huddle.test:443',
          origin: 'https://huddle.test',
        }),
      ),
    ).toBe(true);
  });

  it('compares host names without case', () => {
    expect(
      sameOrigin(
        request('https://huddle.test/huddle', {
          host: 'Huddle.Test',
          origin: 'https://huddle.test',
        }),
      ),
    ).toBe(true);
  });

  it('refuses an Origin on another host', () => {
    expect(
      sameOrigin(
        request('https://huddle.test/huddle', { host: 'huddle.test', origin: 'https://evil.test' }),
      ),
    ).toBe(false);
  });

  it('refuses an Origin on another port', () => {
    expect(
      sameOrigin(
        request('http://localhost:3000/huddle', {
          host: 'localhost:3000',
          origin: 'http://localhost:5173',
        }),
      ),
    ).toBe(false);
  });

  it('refuses an Origin that is not a URL, such as null', () => {
    expect(
      sameOrigin(request('https://huddle.test/huddle', { host: 'huddle.test', origin: 'null' })),
    ).toBe(false);
  });

  it('ignores X-Forwarded-Host', () => {
    expect(
      sameOrigin(
        request('https://internal.test/huddle', {
          host: 'internal.test',
          origin: 'https://huddle.test',
          'x-forwarded-host': 'huddle.test',
        }),
      ),
    ).toBe(false);
  });

  it('uses the URL host when the request has no Host header, as a rebuilt request on Cloudflare', () => {
    expect(
      sameOrigin(request('https://do.internal/huddle', { origin: 'https://huddle.test' })),
    ).toBe(false);
    expect(
      sameOrigin(request('https://huddle.test/huddle', { origin: 'https://huddle.test' })),
    ).toBe(true);
  });

  it('allows an Origin listed in allowedOrigins', () => {
    const check = createOriginCheck(['http://localhost:5173']);

    expect(
      check(
        request('http://localhost:3000/huddle', {
          host: 'localhost:3000',
          origin: 'http://localhost:5173',
        }),
      ),
    ).toBe(true);
  });

  it('compares allowedOrigins by scheme, host and port', () => {
    const check = createOriginCheck(['http://localhost:5173']);

    expect(
      check(
        request('http://localhost:3000/huddle', {
          host: 'localhost:3000',
          origin: 'https://localhost:5173',
        }),
      ),
    ).toBe(false);
  });

  it('still allows the same origin when allowedOrigins is set', () => {
    const check = createOriginCheck(['http://localhost:5173']);

    expect(
      check(
        request('http://localhost:3000/huddle', {
          host: 'localhost:3000',
          origin: 'http://localhost:3000',
        }),
      ),
    ).toBe(true);
  });

  it('throws at setup for an entry that is not an origin', () => {
    expect(() => createOriginCheck(['localhost:5173'])).toThrow(/allowedOrigins/);
    expect(() => createOriginCheck(['https://huddle.test/path'])).toThrow(/allowedOrigins/);
  });
});
