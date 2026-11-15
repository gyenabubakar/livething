import { createPresenceBatcher } from '~/channel/presence-batch.ts';
import { createChannelMembershipKey } from '~/channel/runtime.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConnection } from '~/_engine/runtime/types.ts';
import type { PresenceChange } from '~/channel/presence-batch.ts';

const room = { channelName: 'room:general', channelFamily: 'rooms' } as const;
const windowMs = 500;

function member(id: string): RuntimeConnection {
  return { id } as RuntimeConnection;
}

function setup() {
  const members = new Set<RuntimeConnection>();
  const channelMembers = new Map([
    [createChannelMembershipKey(room.channelName, room.channelFamily), members],
  ]);
  const sent: { to: string[]; changes: string[] }[] = [];
  const logger = { error: vi.fn() };
  const batcher = createPresenceBatcher({
    channelMembers,
    logger,
    windowMsOf: () => windowMs,
    send({ payloadJson, recipients }) {
      const { changes } = JSON.parse(payloadJson) as { changes: PresenceChange[] };
      sent.push({
        to: recipients.map((recipient) => recipient.id),
        changes: changes.map((change) => `${change.kind} ${change.memberId}`),
      });
    },
  });

  function joins(id: string): RuntimeConnection {
    const connection = member(id);
    members.add(connection);
    batcher.record(room, [change('join', id), change('online', id)], connection);
    return connection;
  }

  function take(): { to: string[]; changes: string[] }[] {
    // Each member gets one frame, so the order between frames does not matter.
    const taken = [...sent].sort((a, b) => a.to[0]!.localeCompare(b.to[0]!));
    sent.length = 0;
    return taken;
  }

  return { members, batcher, logger, joins, take };
}

function change(kind: PresenceChange['kind'], memberId: string): PresenceChange {
  return { kind, memberId };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('presence batching', () => {
  it('sends the first change on a quiet channel at once, to every member but the joiner', () => {
    const t = setup();
    t.members.add(member('alice'));

    t.joins('bob');

    expect(t.take()).toEqual([{ to: ['alice'], changes: ['join bob', 'online bob'] }]);
  });

  it('holds the changes that come during the window and sends them together, in order', () => {
    const t = setup();
    const alice = member('alice');
    t.members.add(alice);
    t.joins('bob');
    t.take();

    t.joins('carol');
    t.members.delete(alice);
    t.batcher.record(room, [change('leave', 'alice'), change('offline', 'alice')]);
    expect(t.take()).toEqual([]);

    vi.advanceTimersByTime(windowMs);

    expect(t.take()).toEqual([
      { to: ['bob'], changes: ['join carol', 'online carol', 'leave alice', 'offline alice'] },
      { to: ['carol'], changes: ['leave alice', 'offline alice'] },
    ]);
  });

  it('gives a member that joined during the window only the changes after its own join', () => {
    const t = setup();
    t.members.add(member('alice'));
    t.joins('bob');
    t.take();

    t.joins('carol');
    t.joins('dave');
    vi.advanceTimersByTime(windowMs);

    expect(t.take()).toEqual([
      { to: ['alice', 'bob'], changes: ['join carol', 'online carol', 'join dave', 'online dave'] },
      { to: ['carol'], changes: ['join dave', 'online dave'] },
    ]);
  });

  it('gives a joiner that adds no change only what comes after it subscribed', () => {
    const t = setup();
    t.members.add(member('alice'));
    t.joins('bob');
    t.take();

    t.joins('carol');
    const secondTab = member('alice-tab-2');
    t.members.add(secondTab);
    t.batcher.record(room, [], secondTab);
    t.joins('dave');

    vi.advanceTimersByTime(windowMs);

    const toSecondTab = t.take().find((frame) => frame.to.includes('alice-tab-2'));
    expect(toSecondTab?.changes).toEqual(['join dave', 'online dave']);
  });

  it('sends what is waiting at once on flush, so a channel message never arrives first', () => {
    const t = setup();
    t.members.add(member('alice'));
    t.joins('bob');
    t.take();

    t.joins('carol');
    t.batcher.flush(room.channelName, room.channelFamily);

    expect(t.take()).toEqual([{ to: ['alice', 'bob'], changes: ['join carol', 'online carol'] }]);

    vi.advanceTimersByTime(windowMs);
    expect(t.take()).toEqual([]);
  });

  it('keeps batching after a flush until the window ends', () => {
    const t = setup();
    t.members.add(member('alice'));
    t.joins('bob');
    t.take();

    t.batcher.flush(room.channelName, room.channelFamily);
    t.joins('carol');
    expect(t.take()).toEqual([]);

    vi.advanceTimersByTime(windowMs);
    expect(t.take()).toEqual([{ to: ['alice', 'bob'], changes: ['join carol', 'online carol'] }]);
  });

  it('sends at once again after a window with no change', () => {
    const t = setup();
    t.members.add(member('alice'));
    t.joins('bob');
    vi.advanceTimersByTime(windowMs);
    t.take();

    t.joins('carol');

    expect(t.take()).toEqual([{ to: ['alice', 'bob'], changes: ['join carol', 'online carol'] }]);
  });

  it('sends nothing to a member that left before the window ended', () => {
    const t = setup();
    const alice = member('alice');
    t.members.add(alice);
    t.joins('bob');
    t.take();

    t.joins('carol');
    t.members.delete(alice);
    vi.advanceTimersByTime(windowMs);

    expect(t.take().flatMap((frame) => frame.to)).not.toContain('alice');
  });

  it('logs and skips a change that cannot become JSON, and keeps batching', () => {
    const t = setup();
    t.members.add(member('alice'));
    t.joins('bob');
    t.take();

    const carol = member('carol');
    t.members.add(carol);
    t.batcher.record(room, [{ kind: 'join', memberId: 'carol', meta: { n: 1n } }], carol);
    t.joins('dave');
    vi.advanceTimersByTime(windowMs);

    expect(t.logger.error).toHaveBeenCalledOnce();
    expect(t.take().find((frame) => frame.to.includes('alice'))?.changes).toEqual([
      'join dave',
      'online dave',
    ]);

    t.joins('erin');
    vi.advanceTimersByTime(windowMs);
    expect(t.take().find((frame) => frame.to.includes('alice'))?.changes).toEqual([
      'join erin',
      'online erin',
    ]);
  });

  it('stops its timers on close', () => {
    const t = setup();
    t.members.add(member('alice'));
    t.joins('bob');
    t.joins('carol');

    t.batcher.close();
    t.take();
    vi.advanceTimersByTime(windowMs);

    expect(t.take()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
