import { isIP } from 'node:net';
import proxyaddr from '@fastify/proxy-addr';
import type { IncomingMessage } from 'node:http';

/** Use the TCP peer address as the client address. */
interface NodeDirectClientIpConfig {
  mode: 'direct';
}

/** Resolve a client address through an explicitly trusted proxy chain. */
interface NodeProxyClientIpConfig {
  mode: 'proxy';
  trustedProxies: readonly string[];
}

/** The strategies Node supports for deriving `LiveThing-Client-IP`. */
export type NodeClientIpConfig = NodeDirectClientIpConfig | NodeProxyClientIpConfig;

/** Resolves a client address for one incoming Node request. */
export type ClientIpResolver = (request: IncomingMessage) => string | undefined;

/**
 * Creates the client-IP resolver used while building the Web API `Request`.
 *
 * Without configuration, the adapter omits `LiveThing-Client-IP`. Proxy mode only
 * returns a forwarded address when every hop it trusts is a valid IP address.
 */
export function createClientIpResolver(config?: NodeClientIpConfig): ClientIpResolver {
  if (!config) {
    return () => undefined;
  }

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
