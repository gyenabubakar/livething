/**
 * Compile-time fixtures for `channel.awareness`: present only on channels whose contract
 * has `awareness`, and only when `awareness()` is installed.
 */
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { awareness } from '~/primitives/awareness/awareness.ts';
import { channels } from '~/primitives/channels/index.ts';
import { expectTypeOf } from 'vitest';
import type { AwarenessEntry } from '~/primitives/awareness/types.ts';

type Viewing = { viewingMessageId: string | null };

interface C {
  channels: {
    rooms: { addressing: 'dynamic'; awareness: Viewing; incoming: {}; outgoing: {} };
    lobby: { incoming: {}; outgoing: {} };
  };
}

const socket = client<C>()(connect('wss://huddle.example/huddle'), channels(), awareness());
const general = socket.channel('rooms', 'room:general');

expectTypeOf(general.awareness.others.get()).toEqualTypeOf<
  ReadonlyMap<string, AwarenessEntry<Viewing>>
>();
expectTypeOf(general.awareness.mine.get()).toEqualTypeOf<Viewing | null>();
general.awareness.set({ viewingMessageId: 'm1' });
// @ts-expect-error — the state must match the channel's awareness type.
general.awareness.set({ viewingMessageId: 1 });

// @ts-expect-error — a channel without awareness has no `awareness`.
void socket.channel('lobby').awareness;

const withoutPrimitive = client<C>()(connect('wss://huddle.example/huddle'), channels());
// @ts-expect-error — `awareness()` is not installed.
void withoutPrimitive.channel('rooms', 'room:general').awareness;

// @ts-expect-error — `awareness()` needs `channels()`.
client<C>()(connect('wss://huddle.example/huddle'), awareness());
