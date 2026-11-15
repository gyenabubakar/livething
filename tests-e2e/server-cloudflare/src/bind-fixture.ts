import { bind, http, websocket } from '@livething/server-cloudflare';
import { hasCapability } from '@livething/server/adapters';
import type { CloudflareBindOptions } from '@livething/server-cloudflare';
import type { ServerDefinition } from '@livething/server/adapters';

/** `bind()` for a test fixture. One with keepalive() offers both transports, so one suite runs over each. */
export function bindFixture<TDefinition extends ServerDefinition>(
  definition: TDefinition,
  options: CloudflareBindOptions = {},
) {
  const transports = hasCapability(definition, 'keepalive') ? [websocket(), http()] : undefined;

  return bind(definition, { ...(transports ? { transports } : {}), ...options });
}
