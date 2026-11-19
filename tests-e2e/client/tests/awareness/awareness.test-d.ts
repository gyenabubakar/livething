import { awareness, channels, client, connect } from '@livething/client';
import type { AwarenessEntry, AwarenessRefusal } from '@livething/client';
import type { AwarenessClient } from '@livething/tests-e2e-handlers/awareness';

// Type-only proof that @livething/client adds `awareness` to a channel whose server config has
// the option, typed by the server's state schema. tsc checks this file; nothing runs it.
type RoomAwareness = { viewingMessageId: string | null };

const socket = client<AwarenessClient>()(connect('wss://example.test/ws'), channels(), awareness());

const general = socket.channel('rooms', 'room:general');

general.awareness.set({ viewingMessageId: 'msg-1' });
general.awareness.set({ viewingMessageId: null });
// @ts-expect-error — the state must match the room's awareness schema.
general.awareness.set({ viewingMessageId: 1 });
general.awareness.clear();

const _mine: RoomAwareness | null = general.awareness.mine.get();
const _self: AwarenessEntry<RoomAwareness> | null = general.awareness.self.get();
const _others: ReadonlyMap<string, AwarenessEntry<RoomAwareness>> = general.awareness.others.get();
const _synced: boolean = general.awareness.synced.get();
const _stopRefused: () => void = general.awareness.onRefused((_refusal: AwarenessRefusal) => {});

// @ts-expect-error — the lobby has no awareness option.
void socket.channel('lobby').awareness;

export type {};
