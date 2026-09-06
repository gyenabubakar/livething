/* oxlint-disable @typescript-eslint/no-explicit-any */
import { channelRuntime, memberRuntime } from '~/_engine/engine.deps.ts';
import * as EngineChannelFrames from '~/_engine/runtime/channel-frames.ts';
import { reconcileMembershipOnBoot } from '~/channel/cleanup.ts';
import { buildChannelFamilyExtra, buildChannelsApi } from '~/channel/context.ts';
import {
  autoRejoinIdentity,
  deleteDurableMembership,
  hasDurableMembership,
  persistMembership,
  purgeChannelMembership,
} from '~/channel/membership.ts';
import * as ChannelPrimitive from '~/channel/runtime.ts';
import { ensureMembershipSchema } from '~/channel/storage.ts';
import { definePrimitive } from '~/primitive.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { EngineCore } from '~/_engine/core.ts';
import type { ChannelMembershipService, ChannelService } from '~/_engine/runtime/feature-slots.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

/**
 * Durable channel-membership operations, reached through the engine's
 * `channelMembershipService` slot. Registered by the `channels()` capability —
 * a handler without it never pulls the membership storage or rejoin code.
 * Each op already no-ops for a channel opted out with `membership: 'ephemeral'`,
 * so an unset slot behaves the same as the opted-out path.
 */
export const channelMembershipService: ChannelMembershipService = {
  persistMembership,
  deleteDurableMembership,
  hasDurableMembership,
  autoRejoinIdentity,
};

/**
 * Bind `leaveChannel` to one engine core. The kick and unsubscribe flows both
 * hand this to the channel primitive so a leave runs the full lifecycle
 * (hooks, peer broadcasts, durable cleanup).
 */
function boundLeave(core: EngineCore) {
  return (connection: RuntimeConnection, opts: ChannelPrimitive.LeaveChannelOptions) =>
    ChannelPrimitive.leaveChannel(channelRuntime(core), connection, opts);
}

/**
 * The channel subscribe/leave/kick runtime, reached through the engine's
 * `channelService` slot. Each method rebuilds its dependency bag from `core`, so
 * the engine never imports the channel-protocol engine to call them. Registered
 * by the `channels()` capability — a server that does not list that capability
 * leaves the slot unset and ships none of this.
 */
export const channelService: ChannelService = {
  handleSubscribe(core, connection, frame) {
    return EngineChannelFrames.handleSubscribe(channelRuntime(core), connection, frame);
  },

  handleUnsubscribe(core, connection, frame) {
    return EngineChannelFrames.handleUnsubscribe(
      { ...channelRuntime(core), leaveChannel: boundLeave(core) },
      connection,
      frame,
    );
  },

  handleMemberSync(core, connection, frame) {
    EngineChannelFrames.handleMemberSync(channelRuntime(core), connection, frame);
  },

  leaveChannel(core, connection, opts) {
    return ChannelPrimitive.leaveChannel(channelRuntime(core), connection, opts);
  },

  getChannelMembers(core, channelName, channelFamily) {
    return EngineChannelFrames.getChannelMembers(memberRuntime(core), channelName, channelFamily);
  },

  kickChannelMembers(core, opts) {
    return EngineChannelFrames.kickChannelMembers(
      { ...channelRuntime(core), leaveChannel: boundLeave(core) },
      opts,
    );
  },

  subscribeFromServer(core, ref, opts) {
    return EngineChannelFrames.subscribeFromServer(
      { ...channelRuntime(core), instanceId: core.engineInstanceId },
      ref,
      opts,
    );
  },
};

const CHANNEL_RUNTIME_KEY = Symbol('channel-runtime');

/**
 * Wire the channel runtime and the `ctx.channels` / `ctx.channel` surface into
 * the engine. `installOnce` keeps the slots set a single time even when several
 * channels are declared.
 */
export function registerChannelRuntime(engine: EngineAccess): void {
  engine.installOnce(CHANNEL_RUNTIME_KEY, () => {
    engine.setChannelService(channelService);
    engine.setChannelContext({ buildChannelsApi, buildChannelFamilyExtra });
    engine.setChannelMembershipService(channelMembershipService);

    engine.onBootSchema(() => {
      ensureMembershipSchema(engine.storage.sql);
    });

    engine.onBoot(() => {
      const dropped = reconcileMembershipOnBoot(engine.storage.sql, (name, scope) =>
        engine.isDurableMembershipPairDurable(name, scope),
      );
      if (dropped > 0) {
        engine
          .getLogger?.()
          ?.info?.(
            `[wskit] channel membership boot cleanup dropped ${dropped} orphaned channel-scope row group(s)`,
          );
      }
    });

    engine.onPurgeUser((core, userId) => purgeChannelMembership(core as EngineCore, userId));
  });
}

export const channelRuntimePrimitive = definePrimitive({
  tag: 'channel-runtime',
  key: Symbol('channel-runtime-primitive'),
  kind: 'infrastructure',
  create: () => ({}),
  setup(engine) {
    registerChannelRuntime(engine);
  },
});
