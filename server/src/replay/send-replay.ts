import { ENGINE_INTERNAL_CONNECTION } from '~/_engine/contexts/contexts.ts';
import { isBinaryPayload } from '~/outgoing/binary-payload.ts';
import { matchesReplayScope, readReplayContextScope } from '~/replay/runtime.ts';
import type { EngineAccess } from '~/_engine/access.ts';
import type { BinaryPayload } from '~/outgoing/binary-payload.ts';
import type { ReplayWire } from './wire.ts';

/**
 * The `wire` a top-level `ctx.sendReplay` receives. `channel`, when present, is
 * a static channel declaration or a family declaration's `.at(params)` ref.
 */
interface TopLevelSendReplayWire {
  readonly deliverySeq: number;
  readonly messageId: string;
  readonly channel?: unknown;
}

interface ReplayChannelTarget {
  channelName: string | null;
  channelFamily: string | null;
}

/** Which scopes one `sendReplay` extender attaches to. */
export interface SendReplayExtenderOptions {
  /**
   * Set for a channel-scoped instance: only that channel's `ctx.channel` gets
   * `sendReplay`. Leave it out for a server-level instance, which attaches
   * `ctx.sendReplay` and `ctx.channel.sendReplay` in every channel it has not
   * ceded to another instance.
   */
  channelKey: string | undefined;

  /** The channels another replay instance owns. */
  claimedChannelKeys: () => ReadonlySet<string>;
}

/**
 * Turn the `wire.channel` of a top-level `ctx.sendReplay` into the channel it
 * targets. No channel means the top-level scope.
 */
function resolveReplayChannel(channel: unknown): ReplayChannelTarget {
  if (channel === undefined) return { channelName: null, channelFamily: null };

  if (channel && typeof channel === 'object') {
    if ('__livethingChannelRef' in channel) {
      const ref = channel as unknown as { family: string; name: string };
      return { channelName: ref.name, channelFamily: ref.family };
    }

    if ('__livethingChannel' in channel) {
      return { channelName: (channel as unknown as { __key: string }).__key, channelFamily: null };
    }
  }

  throw new Error(
    '[livething] ctx.sendReplay: `wire.channel` must be a static channel declaration or a ' +
      "family's `.at(params)` ref.",
  );
}

/**
 * The info and the bytes of a `.binary.sendReplay(...)`, which hands its info and bytes to
 * `sendReplay` in the payload's place, or a JSON payload as it is.
 */
function splitReplayPayload(given: unknown): { payload: unknown; bytes?: Uint8Array } {
  if (!isBinaryPayload(given)) return { payload: given };

  const binary = given as BinaryPayload;
  return { payload: binary.info, bytes: binary.bytes };
}

/**
 * Resolve the current connection's id from a handler ctx. Reads the engine's
 * stashed runtime connection first — it is always present on a built ctx — so
 * the id is available regardless of how the public `ctx.connection` ref is
 * surfaced on a given dispatch.
 */
export function readConnectionId(ctx: Record<PropertyKey, unknown>): string {
  const runtime = ctx[ENGINE_INTERNAL_CONNECTION] as { id?: string } | undefined;
  return runtime?.id ?? (ctx as { connection?: { id?: string } }).connection?.id ?? '';
}

/**
 * Build the context extender that attaches `ctx.sendReplay` (top-level scope)
 * and `ctx.channel.sendReplay` (channel scope) to every live connection ctx.
 * Both send one stored message back to the calling connection as a replay
 * frame, after the same declaration check a normal send runs.
 */
export function createSendReplayExtender(
  engine: EngineAccess,
  options: SendReplayExtenderOptions,
): (ctx: unknown) => Record<string, unknown> {
  const { channelKey, claimedChannelKeys } = options;

  return (ctx) => {
    const base = ctx as Record<PropertyKey, unknown> & {
      channel?: Record<PropertyKey, unknown>;
      sendReplay?: (event: string, payload: unknown, wire: TopLevelSendReplayWire) => void;
    };
    const scope = readReplayContextScope(base);
    const connectionId = readConnectionId(base);
    if (!connectionId) return {};

    const inChannel = Boolean(scope.channelName || scope.channelFamily);
    if (channelKey || inChannel) {
      const owned = channelKey
        ? scope.channelFamily === channelKey || scope.channelName === channelKey
        : matchesReplayScope(undefined, scope, claimedChannelKeys());
      if (!owned || !base.channel) return {};

      const channelName = scope.channelName ?? null;
      const channelFamily = scope.channelFamily ?? null;
      base.channel.sendReplay = (event: string, given: unknown, wire: ReplayWire) => {
        const { payload, bytes } = splitReplayPayload(given);
        engine.assertReplaySendContract(event, payload, {
          channel: channelName ?? undefined,
          channelFamily,
          bytes,
        });
        engine.sendReplay(connectionId, {
          channelName,
          channelFamily,
          event,
          payload,
          bytes,
          wire,
        });
      };

      return {};
    }

    base.sendReplay = (event, given, wire) => {
      const target = resolveReplayChannel(wire.channel);
      const { payload, bytes } = splitReplayPayload(given);
      engine.assertReplaySendContract(event, payload, {
        channel: target.channelName ?? undefined,
        channelFamily: target.channelFamily,
        bytes,
      });
      engine.sendReplay(connectionId, {
        channelName: target.channelName,
        channelFamily: target.channelFamily,
        event,
        payload,
        bytes,
        wire: { deliverySeq: wire.deliverySeq, messageId: wire.messageId },
      });
    };

    return {};
  };
}
