import { createChannelMembershipKey } from '~/channel/runtime.ts';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';

/** One change to a channel's member list or to a member's online state. */
export interface PresenceChange {
  kind: 'join' | 'leave' | 'online' | 'offline';
  memberId: string;
  meta?: Record<string, unknown>;
}

export interface PresenceScope {
  channelName: string;
  channelFamily: string | null;
}

interface PresenceSend {
  scope: PresenceScope;
  /** The `__memberChanges__` payload as JSON: `{"changes":[...]}`. */
  payloadJson: string;
  recipients: RuntimeConnection[];
}

export interface PresenceBatcherDeps {
  channelMembers: Map<string, Set<RuntimeConnection>>;
  logger: { error(message: string, details?: Record<string, unknown>): void };
  /** How long one window lasts for this channel, in milliseconds. */
  windowMsOf(scope: PresenceScope): number;
  /** Send one `__memberChanges__` frame with these changes to these members. */
  send(input: PresenceSend): void;
}

interface PendingPresence {
  scope: PresenceScope;
  /** The channel's key in `channelMembers`. */
  membersKey: string;
  /** The waiting changes as JSON, built when each one was recorded. */
  changes: string[];
  /**
   * Where each member that joined during this window starts reading `changes`. Its member
   * sync already showed everything before that point. Members not listed start at 0.
   */
  starts: Map<RuntimeConnection, number>;
  timer: ReturnType<typeof setTimeout>;
}

export interface PresenceBatcher {
  /**
   * Add changes for a channel. `joiner` is a connection that just got its member sync: it
   * gets only the changes that come after this call.
   */
  record(scope: PresenceScope, changes: PresenceChange[], joiner?: RuntimeConnection): void;
  /** Send what is waiting for this channel now, before another message goes to its members. */
  flush(channelName: string, channelFamily: string | null): void;
  close(): void;
}

/**
 * Batch presence changes per channel. The first change on a quiet channel goes out at once
 * and opens a window. Changes during the window wait and go out together when it ends, so a
 * burst of joins costs each member one frame per window, not one frame per join.
 */
export function createPresenceBatcher(deps: PresenceBatcherDeps): PresenceBatcher {
  // By family, then by channel name. `flush` runs before every channel message, so the lookup
  // builds no key string.
  const pending = new Map<string | null, Map<string, PendingPresence>>();

  function waiting(scope: PresenceScope): PendingPresence | undefined {
    return pending.get(scope.channelFamily)?.get(scope.channelName);
  }

  function send(batch: PendingPresence): void {
    if (batch.changes.length === 0) return;

    const { scope, changes, starts } = batch;
    batch.changes = [];
    batch.starts = new Map();

    const groups = new Map<number, RuntimeConnection[]>();
    for (const member of deps.channelMembers.get(batch.membersKey) ?? []) {
      const start = starts.get(member) ?? 0;
      if (start >= changes.length) continue;

      const group = groups.get(start);
      if (group) group.push(member);
      else groups.set(start, [member]);
    }

    // Each group gets the changes from its start to the end. Joining them from the end lets
    // each group's text reuse the text after it.
    const latestFirst = [...groups.keys()].sort((a, b) => b - a);
    let tail = '';
    let index = changes.length;
    for (const start of latestFirst) {
      for (; index > start; index--) {
        const json = changes[index - 1]!;
        tail = tail === '' ? json : `${json},${tail}`;
      }

      deps.send({ scope, payloadJson: `{"changes":[${tail}]}`, recipients: groups.get(start)! });
    }
  }

  function forget(scope: PresenceScope): void {
    const family = pending.get(scope.channelFamily);
    family?.delete(scope.channelName);
    if (family?.size === 0) pending.delete(scope.channelFamily);
  }

  function openWindow(scope: PresenceScope): PendingPresence {
    const batch: PendingPresence = {
      scope,
      membersKey: createChannelMembershipKey(scope.channelName, scope.channelFamily),
      changes: [],
      starts: new Map(),
      timer: setTimeout(endWindow, deps.windowMsOf(scope)),
    };

    (batch.timer as { unref?: () => void }).unref?.();

    function endWindow(): void {
      if (batch.changes.length === 0) {
        forget(scope);
        return;
      }

      send(batch);
      batch.timer = setTimeout(endWindow, deps.windowMsOf(scope));
      (batch.timer as { unref?: () => void }).unref?.();
    }

    let family = pending.get(scope.channelFamily);
    if (!family) {
      family = new Map();
      pending.set(scope.channelFamily, family);
    }

    family.set(scope.channelName, batch);

    return batch;
  }

  return {
    record(scope, changes, joiner) {
      const open = waiting(scope);
      // With no window open, a joiner that adds no change has nothing to skip, and opening a
      // window here would hold back the next change on a quiet channel.
      if (!open && changes.length === 0) return;

      const batch = open ?? openWindow(scope);
      for (const change of changes) {
        // Built now, so a bad `meta` fails here, for this change only, and not in the timer.
        try {
          batch.changes.push(JSON.stringify(change));
        } catch (error) {
          deps.logger.error('[livething] a presence change could not become JSON; skipping it', {
            channel: scope.channelName,
            channelFamily: scope.channelFamily,
            memberId: change.memberId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (joiner) batch.starts.set(joiner, batch.changes.length);

      if (!open) send(batch);
    },

    flush(channelName, channelFamily) {
      const batch = pending.get(channelFamily)?.get(channelName);
      if (batch) send(batch);
    },

    close() {
      for (const family of pending.values()) {
        for (const batch of family.values()) clearTimeout(batch.timer);
      }

      pending.clear();
    },
  };
}
