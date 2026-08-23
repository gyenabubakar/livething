import { isIP } from 'node:net';
import proxyaddr from '@fastify/proxy-addr';
import type { IncomingMessage } from 'node:http';

export interface NodeDirectClientIpConfig {
  mode: 'direct';
}

export interface NodeProxyClientIpConfig {
  mode: 'proxy';
  trustedProxies: readonly string[];
}

export type NodeClientIpConfig = NodeDirectClientIpConfig | NodeProxyClientIpConfig;

export type ClientIpResolver = (request: IncomingMessage) => string | undefined;

export function createClientIpResolver(config?: NodeClientIpConfig): ClientIpResolver {
  if (!config) return () => undefined;

  if (config.mode === 'direct') {
    return (request) => {
      const address = request.socket.remoteAddress;
      return address && isIP(address) !== 0 ? address : undefined;
    };
  }

  const mode: unknown = config.mode;
  if (mode !== 'proxy') {
    throw new TypeError(`Unsupported clientIp mode: ${String(mode)}`);
  }

  if (config.trustedProxies.length === 0) {
    throw new TypeError('clientIp.trustedProxies must contain at least one proxy');
  }

  const trust = proxyaddr.compile([...config.trustedProxies]);

  return (request) => {
    const addresses = proxyaddr.all(request);
    const directAddress = addresses[0];

    if (!directAddress || isIP(directAddress) === 0 || !trust(directAddress, 0)) {
      return undefined;
    }

    for (let index = 1; index < addresses.length; index += 1) {
      const address = addresses[index];
      if (!address || isIP(address) === 0) return undefined;
      if (!trust(address, index)) return address;
    }

    return undefined;
  };
}
