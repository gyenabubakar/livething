// Type-only checks for the plugin socket. tsc checks these; vitest never runs them.
import { expectTypeOf } from 'vitest';
import type { PluginSocket } from '~/plugins/plugin-socket.ts';

interface ChatContract {
  incoming: { message: { id: string; text: string } };
  outgoing: { typing: { on: boolean } };
  requests: { 'send-message': { payload: { text: string }; response: { id: string } } };
  channels: { room: { incoming: { reaction: { emoji: string } } } };
}

type ChatSocket = PluginSocket<ChatContract>;

// Typed receive, scoped to the plugin's own events.
expectTypeOf<ChatSocket['on']>().toBeFunction();
expectTypeOf<Parameters<ChatSocket['on']>[0]>().toEqualTypeOf<'message'>();
expectTypeOf<Parameters<Parameters<ChatSocket['on']>[1]>[0]>().toEqualTypeOf<{
  id: string;
  text: string;
}>();

// Typed fire-and-forget send.
expectTypeOf<Parameters<ChatSocket['send']>[0]>().toEqualTypeOf<'typing'>();
expectTypeOf<Parameters<ChatSocket['send']>[1]>().toEqualTypeOf<{ on: boolean }>();

// Typed request/response.
expectTypeOf<ChatSocket['request']>().toBeFunction();
expectTypeOf<ReturnType<ChatSocket['request']>>().toEqualTypeOf<Promise<{ id: string }>>();

// Typed channel handle.
expectTypeOf<ChatSocket['channel']>().toBeFunction();
expectTypeOf<Parameters<ChatSocket['channel']>[0]>().toEqualTypeOf<'room'>();

// The always-present taps and tools are there too.
expectTypeOf<ChatSocket['onIncoming']>().toBeFunction();
expectTypeOf<ChatSocket['onOutgoing']>().toBeFunction();
expectTypeOf<ChatSocket['onOpen']>().toBeFunction();
expectTypeOf<ChatSocket['onClose']>().toBeFunction();
expectTypeOf<ChatSocket['generateId']>().toBeFunction();
expectTypeOf<ChatSocket['hasPrimitive']>().toBeFunction();

// A plugin with no contract (observe-only) has the taps and tools but none of the
// typed verbs.
type PlainSocket = PluginSocket;
expectTypeOf<PlainSocket['onIncoming']>().toBeFunction();
expectTypeOf<PlainSocket['generateId']>().toBeFunction();
expectTypeOf<PlainSocket>().not.toHaveProperty('on');
expectTypeOf<PlainSocket>().not.toHaveProperty('send');
expectTypeOf<PlainSocket>().not.toHaveProperty('request');
expectTypeOf<PlainSocket>().not.toHaveProperty('channel');

// A plugin that only receives (incoming, no requests/channels) has `on` but not
// `request` or `channel`.
type ReceiveOnly = PluginSocket<{ incoming: { tick: { n: number } } }>;
expectTypeOf<ReceiveOnly['on']>().toBeFunction();
expectTypeOf<ReceiveOnly>().not.toHaveProperty('request');
expectTypeOf<ReceiveOnly>().not.toHaveProperty('channel');
