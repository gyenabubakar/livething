/* oxlint-disable @typescript-eslint/no-explicit-any */
import * as ChannelPrimitive from '~/channel/runtime.ts';
import * as OutgoingRuntime from '~/outgoing/runtime.ts';
import type * as Protocol from '~/_engine/runtime/protocol.ts';
import type { SendProtocolMessageOptions } from '~/_engine/runtime/wire.ts';
import type { PresenceChange, PresenceScope } from '~/channel/presence-batch.ts';
import type { MembershipInsert, StoredMembership } from '~/channel/storage.ts';
import type * as PublicApi from '~/context.ts';
import { assertLocalRef } from './refs.ts';
import type * as EngineRuntimeTypes from './types.ts';

type OptsParameter = { error: unknown; event?: string; routing?: Protocol.LiveThingRouting };
type SubscribeFromServerRefParameter = {
  __livething: 'connection-ref';
  id: string;
  instance: string | undefined;
  userId: string;
};

/**
 * Dependency bag for channel subscribe/unsubscribe helpers.
 */
interface ChannelRuntime
  extends EngineRuntimeTypes.ConnectionMembersRuntime, EngineRuntimeTypes.ChannelHooks {
  getDurableMembership(
    userId: string,
    channelName: string,
    channelFamily: string | null,
  ): StoredMembership | undefined;

  listDurableMembers(
    channelName: string,
    channelFamily: string | null,
  ): (StoredMembership & { userId: string })[];

  buildConnectionContext(
    connection: EngineRuntimeTypes.RuntimeConnection,
    scope?: EngineRuntimeTypes.ResolvedChannel,
  ): Record<PropertyKey, unknown>;

  persistAttachment(connection: EngineRuntimeTypes.RuntimeConnection): void;

  sendProtocolMessage(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: SendProtocolMessageOptions,
  ): void;

  broadcastToChannel(opts: ChannelPrimitive.BroadcastToChannelOptions): void;

  recordPresence(
    scope: PresenceScope,
    changes: PresenceChange[],
    joiner?: EngineRuntimeTypes.RuntimeConnection,
  ): void;

  hasPresence(channelKey: string): boolean;

  handleRuntimeError(
    connection: EngineRuntimeTypes.RuntimeConnection,
    opts: OptsParameter,
  ): Promise<void>;

  isChannelDurable(channelKey: string): boolean;

  persistMembership(row: MembershipInsert): void;
  deleteDurableMembership(userId: string, channelName: string, channelFamily: string | null): void;
}

/**
 * Return the current public member snapshot for a channel.
 *
 * The lookup is always exact-match on the (`channelName`, `channelFamily`)
 * pair. Pass `null` for static channels and the family key for dynamic
 * channel families. Two families that happen to share a concrete channel name
 * stay strictly isolated — no membership ever crosses into the wrong family.
 */
export function getChannelMembers(
  runtime: EngineRuntimeTypes.ConnectionMembersRuntime,
  channelName: string,
  channelFamily: string | null,
): PublicApi.ConnectionInfo<Record<string, unknown>>[] {
  const members = runtime.channelMembers.get(
    ChannelPrimitive.createChannelMembershipKey(channelName, channelFamily),
  );
  if (!members) return [];

  return [...members].map((connection) => runtime.toConnectionInfo(connection));
}

/**
 * Remove tagged members from a channel, typically for moderation or access
 * control.
 */
export function kickChannelMembers(
  runtime: ChannelRuntime &
    Pick<
      OutgoingRuntime.OutgoingRuntime,
      'compiled' | 'generateId' | 'logger' | 'outgoingHooks' | 'livethingStampHooks'
    > & {
      leaveChannel(
        connection: EngineRuntimeTypes.RuntimeConnection,
        opts: ChannelPrimitive.LeaveChannelOptions,
      ): Promise<void>;
    },
  opts: ChannelPrimitive.KickChannelMembersOptions,
): Promise<void> {
  return ChannelPrimitive.kickChannelMembers(runtime, opts);
}

type SubscribeRuntime = ChannelRuntime &
  Pick<
    OutgoingRuntime.OutgoingRuntime,
    'compiled' | 'generateId' | 'logger' | 'outgoingHooks' | 'livethingStampHooks'
  >;

const subscribeRuntimes = new WeakMap<SubscribeRuntime, SubscribeRuntime>();

/**
 * The runtime a subscribe runs with: the channel runtime, with broadcasts that go through its
 * outgoing hooks. Made once for each runtime, not copied for each join: the runtime has more
 * than 50 fields. It inherits from the runtime, so its getters still read the current value.
 */
function subscribeRuntimeOf(runtime: SubscribeRuntime): SubscribeRuntime {
  let subscribeRuntime = subscribeRuntimes.get(runtime);
  if (!subscribeRuntime) {
    subscribeRuntime = Object.assign(Object.create(runtime) as SubscribeRuntime, {
      broadcastToChannel: (opts: ChannelPrimitive.BroadcastToChannelOptions) =>
        OutgoingRuntime.broadcastToChannel(runtime, opts),
      toConnectionInfo: (nextConnection: EngineRuntimeTypes.RuntimeConnection) =>
        runtime.toConnectionInfo(nextConnection),
    });
    subscribeRuntimes.set(runtime, subscribeRuntime);
  }

  return subscribeRuntime;
}

/**
 * Handle the `__subscribe__` protocol frame for a channel.
 */
export function handleSubscribe(
  runtime: SubscribeRuntime,
  connection: EngineRuntimeTypes.RuntimeConnection,
  frame: Protocol.SubscribeFrame,
): Promise<void> {
  return ChannelPrimitive.subscribeConnection(subscribeRuntimeOf(runtime), connection, {
    channelName: frame.__livething.channel,
    channelFamily: frame.__livething.channelFamily,
    data: frame.payload,
  });
}

/**
 * Server-initiated `channelHandle.subscribe(ref)`. Looks the target connection
 * up from the ref, refuses cross-instance refs until the broker exists, and
 * delegates to the channel primitive's server-side subscribe path.
 */
export interface SubscribeFromServerOptions {
  channelName: string;
  channelFamily: string | null;
  payload: unknown;
  rejoining?: boolean;
}

export async function subscribeFromServer(
  runtime: ChannelRuntime &
    Pick<
      OutgoingRuntime.OutgoingRuntime,
      'compiled' | 'generateId' | 'logger' | 'outgoingHooks' | 'livethingStampHooks'
    > & { instanceId: string | undefined },
  ref: SubscribeFromServerRefParameter,
  opts: SubscribeFromServerOptions,
): Promise<void> {
  const { channelName, channelFamily, payload, rejoining = false } = opts;
  assertLocalRef(ref, runtime.instanceId, 'channelHandle.subscribe(ref)');

  const target = runtime.connections.get(ref.id);
  if (!target) {
    throw new Error(
      `[livething] channelHandle.subscribe(ref) — no live connection with id "${ref.id}" on this instance.`,
    );
  }

  await ChannelPrimitive.subscribeConnectionAsServer(subscribeRuntimeOf(runtime), target, {
    channelName,
    channelFamily,
    payload,
    rejoining,
  });
}

/**
 * Handle the `__unsubscribe__` protocol frame for a channel.
 */
export async function handleUnsubscribe(
  runtime: ChannelRuntime &
    Pick<
      OutgoingRuntime.OutgoingRuntime,
      'compiled' | 'generateId' | 'logger' | 'outgoingHooks' | 'livethingStampHooks'
    > & {
      leaveChannel(
        connection: EngineRuntimeTypes.RuntimeConnection,
        opts: ChannelPrimitive.LeaveChannelOptions,
      ): Promise<void>;
    },
  connection: EngineRuntimeTypes.RuntimeConnection,
  frame: Protocol.UnsubscribeFrame,
): Promise<void> {
  await ChannelPrimitive.unsubscribeConnection(runtime, connection, {
    channelName: frame.__livething.channel,
    channelFamily: frame.__livething.channelFamily,
    unsubscribeId: frame.__livething.unsubscribeId,
  });
}
