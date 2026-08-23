import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createClientIpResolver } from './client-ip.ts';

function incomingRequest(
  remoteAddress: string | undefined,
  headers: Record<string, string> = {},
): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', {
    configurable: true,
    value: remoteAddress,
  });

  return Object.assign(new IncomingMessage(socket), {
    headers,
  });
}

describe('createClientIpResolver', () => {
  it('returns the direct socket address and ignores forwarding headers', () => {
    const resolveClientIp = createClientIpResolver({ mode: 'direct' });

    expect(
      resolveClientIp(
        incomingRequest('203.0.113.7', {
          'x-forwarded-for': '198.51.100.10',
        }),
      ),
    ).toBe('203.0.113.7');
  });

  it('returns the first untrusted address behind trusted proxies', () => {
    const resolveClientIp = createClientIpResolver({
      mode: 'proxy',
      trustedProxies: ['10.0.0.0/8'],
    });

    expect(
      resolveClientIp(
        incomingRequest('10.0.0.12', {
          'x-forwarded-for': '203.0.113.7, 10.0.0.8',
        }),
      ),
    ).toBe('203.0.113.7');
  });

  it('omits the address when the direct peer is not trusted', () => {
    const resolveClientIp = createClientIpResolver({
      mode: 'proxy',
      trustedProxies: ['10.0.0.0/8'],
    });

    expect(
      resolveClientIp(
        incomingRequest('198.51.100.4', {
          'x-forwarded-for': '203.0.113.7',
        }),
      ),
    ).toBeUndefined();
  });

  it('omits the address when a trusted proxy provides no forwarding chain', () => {
    const resolveClientIp = createClientIpResolver({
      mode: 'proxy',
      trustedProxies: ['10.0.0.0/8'],
    });

    expect(resolveClientIp(incomingRequest('10.0.0.12'))).toBeUndefined();
  });

  it('omits malformed forwarded addresses', () => {
    const resolveClientIp = createClientIpResolver({
      mode: 'proxy',
      trustedProxies: ['10.0.0.0/8'],
    });

    expect(
      resolveClientIp(
        incomingRequest('10.0.0.12', {
          'x-forwarded-for': 'not-an-ip',
        }),
      ),
    ).toBeUndefined();
  });

  it('requires at least one trusted proxy', () => {
    expect(() =>
      createClientIpResolver({
        mode: 'proxy',
        trustedProxies: [],
      }),
    ).toThrow('clientIp.trustedProxies must contain at least one proxy');
  });
});
