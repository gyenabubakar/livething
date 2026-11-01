import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { channels } from '~/primitives/channels/index.ts';
import { installMockWebSocket, MockWebSocket } from '~/test-helpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface C {
  channels: {
    general: {
      incoming: { message: { text: string } };
      outgoing: { 'send-message': { text: string } };
    };
    rooms: {
      addressing: 'dynamic';
      incoming: { message: { text: string } };
      outgoing: { 'send-message': { text: string } };
    };
  };
}

function build() {
  const socket = client<C>()(connect('wss://test'), channels());
  socket.connect();
  const ws = MockWebSocket.last();
  ws.open();

  return { socket, ws };
}

type BuiltSocket = ReturnType<typeof build>['socket'];

async function subscribeChannel(socket: BuiltSocket, ws: MockWebSocket, channelName: 'general') {
  const room = socket.channel(channelName);
  const p = room.subscribe();
  ws.emit({
    event: '__subscribeOk__',
    payload: {},
    metadata: { exchange: { source: 'client' }, channel: { name: channelName } },
  });
  await p;

  return room;
}

let restore: () => void;
beforeEach(() => {
  restore = installMockWebSocket();
});
afterEach(() => {
  restore();
});

describe('__memberOnline__ and __memberOffline__ frames', () => {
  it('fires onMemberOnline when the server sends __memberOnline__', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    const onOnline = vi.fn();
    room.onMemberOnline(onOnline);

    ws.emit({
      event: '__memberOnline__',
      payload: { memberId: 'c1', meta: { name: 'Ada' } },
      metadata: { channel: { name: 'general' } },
    });

    expect(onOnline).toHaveBeenCalledOnce();
    expect(onOnline).toHaveBeenCalledWith('c1', { meta: { name: 'Ada' }, online: true });
  });

  it('fires onMemberOffline when the server sends __memberOffline__', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    const onOffline = vi.fn();
    room.onMemberOffline(onOffline);

    ws.emit({
      event: '__memberOffline__',
      payload: { memberId: 'c1' },
      metadata: { channel: { name: 'general' } },
    });

    expect(onOffline).toHaveBeenCalledOnce();
    expect(onOffline).toHaveBeenCalledWith('c1');
  });
});

describe('__memberOnline__/__memberOffline__ do not mutate the members map', () => {
  it('__memberOnline__ fires the callback but does not add the member to the map', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    const onOnline = vi.fn();
    room.onMemberOnline(onOnline);

    ws.emit({
      event: '__memberOnline__',
      payload: { memberId: 'c42', meta: { name: 'Bob' } },
      metadata: { channel: { name: 'general' } },
    });

    expect(onOnline).toHaveBeenCalledWith('c42', { meta: { name: 'Bob' }, online: true });
    expect(room.members.get().has('c42')).toBe(false);
    expect(room.members.get().size).toBe(0);
  });

  it('__memberOffline__ fires the callback but does not remove a member that is in the map', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    ws.emit({
      event: '__memberJoin__',
      payload: { memberId: 'c1', meta: {} },
      metadata: { channel: { name: 'general' } },
    });
    expect(room.members.get().has('c1')).toBe(true);

    const onOffline = vi.fn();
    room.onMemberOffline(onOffline);

    ws.emit({
      event: '__memberOffline__',
      payload: { memberId: 'c1' },
      metadata: { channel: { name: 'general' } },
    });

    expect(onOffline).toHaveBeenCalledWith('c1');
    expect(room.members.get().has('c1')).toBe(true);
  });
});

describe('channel.members store — snapshot identity', () => {
  it('keeps the same map reference across an online/offline that does not change the roster', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    ws.emit({
      event: '__memberJoin__',
      payload: { memberId: 'c1', meta: {} },
      metadata: { channel: { name: 'general' } },
    });
    const snapshot = room.members.get();

    ws.emit({
      event: '__memberOnline__',
      payload: { memberId: 'c42', meta: { name: 'Bob' } },
      metadata: { channel: { name: 'general' } },
    });
    ws.emit({
      event: '__memberOffline__',
      payload: { memberId: 'c1' },
      metadata: { channel: { name: 'general' } },
    });

    expect(room.members.get()).toBe(snapshot);
  });

  it('publishes a fresh snapshot to subscribers on join and on leave', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    const snapshots: ReadonlyMap<string, { meta: Record<string, unknown> }>[] = [];
    room.members.subscribe((members) => snapshots.push(members));

    ws.emit({
      event: '__memberJoin__',
      payload: { memberId: 'c1', meta: {} },
      metadata: { channel: { name: 'general' } },
    });
    ws.emit({
      event: '__memberLeave__',
      payload: { memberId: 'c1' },
      metadata: { channel: { name: 'general' } },
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).not.toBe(snapshots[1]);
    expect(snapshots[0]?.has('c1')).toBe(true);
    expect(snapshots[1]?.has('c1')).toBe(false);
  });
});

describe('__memberSync__ replaces, not merges, the member roster', () => {
  it('a second __memberSync__ drops stale members and reflects only the new list', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ memberId: 'c1', meta: { name: 'Ada' }, online: true }] },
      metadata: { channel: { name: 'general' } },
    });
    expect(room.members.get().has('c1')).toBe(true);
    expect(room.members.get().size).toBe(1);

    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ memberId: 'c2', meta: { name: 'Bob' }, online: true }] },
      metadata: { channel: { name: 'general' } },
    });

    expect(room.members.get().has('c1')).toBe(false);
    expect(room.members.get().has('c2')).toBe(true);
    expect(room.members.get().size).toBe(1);
  });

  it('a second __memberSync__ fires join+online for new members, not for dropped ones', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');

    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ memberId: 'c1', meta: {}, online: true }] },
      metadata: { channel: { name: 'general' } },
    });

    const onJoin = vi.fn();
    const onOnline = vi.fn();
    room.onMemberJoin(onJoin);
    room.onMemberOnline(onOnline);

    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ memberId: 'c2', meta: { role: 'admin' }, online: true }] },
      metadata: { channel: { name: 'general' } },
    });

    const admin = { meta: { role: 'admin' }, online: true };
    expect(onJoin).toHaveBeenCalledOnce();
    expect(onJoin).toHaveBeenCalledWith('c2', admin);
    expect(onOnline).toHaveBeenCalledOnce();
    expect(onOnline).toHaveBeenCalledWith('c2', admin);
  });
});

describe('top-level channel and scoped channel with same name are independent', () => {
  it('a top-level channel(name) and a scoped channel(scope, name) sharing the same name have distinct state and members', async () => {
    const { socket, ws } = build();

    const topLevel = socket.channel('general');
    const topPromise = topLevel.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await topPromise;

    const scoped = socket.channel('rooms', 'general');
    const scopedPromise = scoped.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general', family: 'rooms' } },
    });
    await scopedPromise;

    ws.emit({
      event: '__memberJoin__',
      payload: { memberId: 'c1' },
      metadata: { channel: { name: 'general', family: 'rooms' } },
    });

    expect(scoped.members.get().has('c1')).toBe(true);
    expect(topLevel.members.get().has('c1')).toBe(false);
  });

  it('events routed to the scoped channel do not fire handlers on the top-level channel', async () => {
    const { socket, ws } = build();

    const topLevel = socket.channel('general');
    const topPromise = topLevel.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general' } },
    });
    await topPromise;

    const scoped = socket.channel('rooms', 'general');
    const scopedPromise = scoped.subscribe();
    ws.emit({
      event: '__subscribeOk__',
      payload: {},
      metadata: { exchange: { source: 'client' }, channel: { name: 'general', family: 'rooms' } },
    });
    await scopedPromise;

    const topHandler = vi.fn();
    const scopedHandler = vi.fn();
    topLevel.on('message', topHandler);
    scoped.on('message', scopedHandler);

    ws.emit({
      event: 'message',
      payload: { text: 'scoped only' },
      metadata: { channel: { name: 'general', family: 'rooms' } },
    });

    expect(scopedHandler).toHaveBeenCalledWith({ text: 'scoped only' });
    expect(topHandler).not.toHaveBeenCalled();
  });

  it('top-level channel(name) and scoped channel(scope,name) are not the same object', () => {
    const { socket } = build();
    const topLevel = socket.channel('general');
    const scoped = socket.channel('rooms', 'general');
    expect(topLevel).not.toBe(scoped);
  });
});

describe('presence frames are ignored while a leave is pending', () => {
  async function subscribedWithPendingLeave() {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ memberId: 'c1', meta: { name: 'Ada' }, online: true }] },
      metadata: { channel: { name: 'general' } },
    });
    expect(room.members.get().size).toBe(1);
    room.unsubscribe();

    return { socket, ws, room };
  }

  it('ignores a __memberSync__ that would repopulate a roster of a leaving channel', async () => {
    const { ws, room } = await subscribedWithPendingLeave();
    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ memberId: 'c2', meta: {}, online: true }] },
      metadata: { channel: { name: 'general' } },
    });
    expect(room.members.get().size).toBe(0);
  });

  it('ignores __memberJoin__/__memberOnline__ while a leave is pending', async () => {
    const { ws, room } = await subscribedWithPendingLeave();
    const onJoin = vi.fn();
    const onOnline = vi.fn();
    room.onMemberJoin(onJoin);
    room.onMemberOnline(onOnline);

    ws.emit({
      event: '__memberJoin__',
      payload: { memberId: 'c3', meta: {} },
      metadata: { channel: { name: 'general' } },
    });
    ws.emit({
      event: '__memberOnline__',
      payload: { memberId: 'c3', meta: {} },
      metadata: { channel: { name: 'general' } },
    });
    expect(onJoin).not.toHaveBeenCalled();
    expect(onOnline).not.toHaveBeenCalled();
    expect(room.members.get().size).toBe(0);
  });
});

describe('presence frames after the channel has been left', () => {
  async function leftChannel() {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    room.unsubscribe();
    const leave = ws.sentFrames().find((f) => f.event === '__unsubscribe__');
    ws.emit({
      event: '__unsubscribeOk__',
      payload: {},
      metadata: {
        channel: { name: 'general', unsubscribeId: leave?.metadata?.channel?.unsubscribeId },
      },
    });

    return { room, ws };
  }

  it('ignores a __memberSync__ that lands after __unsubscribeOk__', async () => {
    const { room, ws } = await leftChannel();
    const onJoin = vi.fn();
    room.onMemberJoin(onJoin);

    ws.emit({
      event: '__memberSync__',
      payload: { members: [{ memberId: 'c1', meta: { name: 'Ada' }, online: true }] },
      metadata: { channel: { name: 'general' } },
    });

    expect(onJoin).not.toHaveBeenCalled();
    expect(room.members.get().size).toBe(0);
  });

  it('ignores a __memberJoin__ that lands after __unsubscribeOk__', async () => {
    const { room, ws } = await leftChannel();
    const onJoin = vi.fn();
    room.onMemberJoin(onJoin);

    ws.emit({
      event: '__memberJoin__',
      payload: { memberId: 'c1', meta: { name: 'Ada' } },
      metadata: { channel: { name: 'general' } },
    });

    expect(onJoin).not.toHaveBeenCalled();
    expect(room.members.get().size).toBe(0);
  });
});

describe('a member keeps one roster entry by its member id', () => {
  function emit(ws: MockWebSocket, event: string, payload: unknown) {
    ws.emit({ event, payload, metadata: { channel: { name: 'general' } } });
  }

  it('keeps one entry across a peer reconnect and removes it on a later leave', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    const onOnline = vi.fn();
    const onOffline = vi.fn();
    const onLeave = vi.fn();

    room.onMemberOnline(onOnline);
    room.onMemberOffline(onOffline);
    room.onMemberLeave(onLeave);

    emit(ws, '__memberJoin__', { memberId: 'alice', meta: { name: 'Alice' } });
    emit(ws, '__memberOnline__', { memberId: 'alice', meta: { name: 'Alice' } });
    emit(ws, '__memberOffline__', { memberId: 'alice' });
    emit(ws, '__memberOnline__', { memberId: 'alice', meta: { name: 'Alice' } });

    expect([...room.members.get().keys()]).toEqual(['alice']);
    expect(onOffline).toHaveBeenCalledWith('alice');
    expect(onOnline.mock.calls.map(([memberId]) => memberId)).toEqual(['alice', 'alice']);

    emit(ws, '__memberLeave__', { memberId: 'alice', meta: { name: 'Alice' } });
    emit(ws, '__memberOffline__', { memberId: 'alice' });

    expect(room.members.get().size).toBe(0);
    expect(onLeave).toHaveBeenCalledWith('alice');
  });

  it('fires leave then offline for an online member that a later sync no longer lists', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    emit(ws, '__memberSync__', {
      members: [
        { memberId: 'alice', meta: {}, online: true },
        { memberId: 'bob', meta: {}, online: true },
      ],
    });

    const calls: string[] = [];
    room.onMemberLeave((memberId) => calls.push(`leave ${memberId}`));
    room.onMemberOffline((memberId) => calls.push(`offline ${memberId}`));
    room.onMemberOnline((memberId) => calls.push(`online ${memberId}`));

    emit(ws, '__memberSync__', { members: [{ memberId: 'alice', meta: {}, online: true }] });

    expect(calls).toEqual(['leave bob', 'offline bob']);
    expect([...room.members.get().keys()]).toEqual(['alice']);
  });
});

describe('a member keeps its roster entry while it is offline', () => {
  function emit(ws: MockWebSocket, event: string, payload: unknown) {
    ws.emit({ event, payload, metadata: { channel: { name: 'general' } } });
  }

  it('lists an offline member from the sync with online: false and fires only join', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    const calls: string[] = [];
    room.onMemberJoin((memberId) => calls.push(`join ${memberId}`));
    room.onMemberOnline((memberId) => calls.push(`online ${memberId}`));

    room.onMemberOffline((memberId) => calls.push(`offline ${memberId}`));

    emit(ws, '__memberSync__', {
      members: [
        { memberId: 'alice', meta: { name: 'Alice' }, online: false },
        { memberId: 'bob', meta: { name: 'Bob' }, online: true },
      ],
    });

    expect(calls).toEqual(['join alice', 'join bob', 'online bob']);
    expect(room.members.get().get('alice')).toEqual({ meta: { name: 'Alice' }, online: false });
    expect(room.members.get().get('bob')).toEqual({ meta: { name: 'Bob' }, online: true });
  });

  it('flips online without adding or removing entries, with a fresh snapshot each time', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    emit(ws, '__memberJoin__', { memberId: 'alice', meta: { name: 'Alice' } });
    expect(room.members.get().get('alice')).toEqual({ meta: { name: 'Alice' }, online: false });

    emit(ws, '__memberOnline__', { memberId: 'alice', meta: { name: 'Alice' } });
    const online = room.members.get();
    expect(online.get('alice')).toEqual({ meta: { name: 'Alice' }, online: true });

    emit(ws, '__memberOffline__', { memberId: 'alice' });
    const offline = room.members.get();
    expect(offline).not.toBe(online);
    expect(offline.get('alice')).toEqual({ meta: { name: 'Alice' }, online: false });
    expect(offline.size).toBe(1);
  });

  it('shows a peer that went offline while the observer was away as offline, with no leave', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    emit(ws, '__memberSync__', {
      members: [{ memberId: 'alice', meta: { name: 'Alice' }, online: true }],
    });

    const calls: string[] = [];
    room.onMemberJoin((memberId) => calls.push(`join ${memberId}`));
    room.onMemberLeave((memberId) => calls.push(`leave ${memberId}`));
    room.onMemberOnline((memberId) => calls.push(`online ${memberId}`));
    room.onMemberOffline((memberId) => calls.push(`offline ${memberId}`));

    emit(ws, '__memberSync__', {
      members: [{ memberId: 'alice', meta: { name: 'Alice' }, online: false }],
    });

    expect(calls).toEqual(['offline alice']);
    expect(room.members.get().get('alice')).toEqual({ meta: { name: 'Alice' }, online: false });
  });

  it('fires only leave for an offline member that a later sync no longer lists', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    emit(ws, '__memberSync__', {
      members: [{ memberId: 'alice', meta: {}, online: false }],
    });

    const calls: string[] = [];
    room.onMemberLeave((memberId) => calls.push(`leave ${memberId}`));
    room.onMemberOffline((memberId) => calls.push(`offline ${memberId}`));

    emit(ws, '__memberSync__', { members: [] });
    expect(calls).toEqual(['leave alice']);
    expect(room.members.get().size).toBe(0);
  });

  it('re-adds a member after a kick with leave, then join and online', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    emit(ws, '__memberSync__', {
      members: [{ memberId: 'alice', meta: { name: 'Alice' }, online: true }],
    });

    const calls: string[] = [];
    room.onMemberJoin((memberId) => calls.push(`join ${memberId}`));
    room.onMemberLeave((memberId) => calls.push(`leave ${memberId}`));
    room.onMemberOnline((memberId) => calls.push(`online ${memberId}`));
    room.onMemberOffline((memberId) => calls.push(`offline ${memberId}`));

    emit(ws, '__memberLeave__', { memberId: 'alice', meta: { name: 'Alice' } });
    emit(ws, '__memberOffline__', { memberId: 'alice' });
    expect(room.members.get().has('alice')).toBe(false);

    emit(ws, '__memberJoin__', { memberId: 'alice', meta: { name: 'Alice' } });
    emit(ws, '__memberOnline__', { memberId: 'alice', meta: { name: 'Alice' } });

    expect(calls).toEqual(['leave alice', 'offline alice', 'join alice', 'online alice']);
    expect(room.members.get().get('alice')).toEqual({ meta: { name: 'Alice' }, online: true });
  });

  it('drops a sync entry that has no online flag', async () => {
    const { socket, ws } = build();
    const room = await subscribeChannel(socket, ws, 'general');
    emit(ws, '__memberSync__', {
      members: [
        { memberId: 'alice', meta: {} },
        { memberId: 'bob', meta: {}, online: true },
      ],
    });

    expect([...room.members.get().keys()]).toEqual(['bob']);
  });
});
