/**
 * Compile-time fixtures for `ChannelConfig.membership`. Omitting it keeps
 * membership durable across a reconnect.
 *
 * These assert against `ChannelConfig` directly rather than through
 * `base.channel(...)`, so each error pins to the `membership` property
 * instead of failing the whole call.
 */
import type { ChannelConfig } from '~/_define/server.ts';

type Config = ChannelConfig<Record<string, never>, Record<string, never>, readonly []>;

({
  membership: 'persistent',
}) satisfies Config;

({
  membership: 'ephemeral',
}) satisfies Config;

({
  // @ts-expect-error — 'sometimes' is not a membership kind `ChannelConfig` knows.
  membership: 'sometimes',
}) satisfies Config;

({
  // @ts-expect-error — `ChannelConfig` has no `persistent` property; the field is `membership`.
  persistent: false,
}) satisfies Config;

({}) satisfies Config;
