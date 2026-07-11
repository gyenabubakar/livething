// Type-only checks for the plugin contract split. tsc checks these; vitest never
// runs them. A broken assumption shows up as a build error.
import { expectTypeOf } from 'vitest';
import type { PluginSlice, TopLevelContract } from '~/plugins/contract.ts';

// A contract shaped like what `InferClient` produces for a host with one plugin
// (`acme:chat`) plus the app's own top-level names.
interface HostContract {
  incoming: {
    'app-notice': { text: string };
    '__acme:chat::message': { id: string; text: string };
    '__acme:chat::typing': { from: string };
  };
  outgoing: {
    'app-ping': { at: number };
    '__acme:chat::typing': { on: boolean };
  };
  requests: {
    'app-balance': { payload: { user: string }; response: { balance: number } };
    '__acme:chat::send-message': { payload: { text: string }; response: { id: string } };
  };
  channels: {
    'app-lobby': { incoming: { hello: { name: string } } };
    '__acme:chat::room': { incoming: { reaction: { emoji: string } } };
  };
  errors: {
    forbidden: { reason: string };
    '__acme:chat::rate-limited': { retryIn: number };
  };
}

type ChatSlice = PluginSlice<HostContract, 'acme:chat'>;

// The plugin sees its own names with the prefix stripped.
expectTypeOf<ChatSlice['incoming']>().toEqualTypeOf<{
  message: { id: string; text: string };
  typing: { from: string };
}>();
expectTypeOf<ChatSlice['outgoing']>().toEqualTypeOf<{ typing: { on: boolean } }>();
expectTypeOf<ChatSlice['requests']>().toEqualTypeOf<{
  'send-message': { payload: { text: string }; response: { id: string } };
}>();
expectTypeOf<ChatSlice['channels']>().toEqualTypeOf<{
  room: { incoming: { reaction: { emoji: string } } };
}>();
expectTypeOf<ChatSlice['errors']>().toEqualTypeOf<{ 'rate-limited': { retryIn: number } }>();

// The plugin's slice never keeps the app's own names.
expectTypeOf<keyof ChatSlice['incoming']>().toEqualTypeOf<'message' | 'typing'>();

// When 'acme:chat' is claimed, the top-level contract keeps the app's names and
// drops that plugin's names.
type ChatClaimed = TopLevelContract<HostContract, 'acme:chat'>;
expectTypeOf<ChatClaimed['incoming']>().toEqualTypeOf<{ 'app-notice': { text: string } }>();
expectTypeOf<ChatClaimed['outgoing']>().toEqualTypeOf<{ 'app-ping': { at: number } }>();
expectTypeOf<ChatClaimed['requests']>().toEqualTypeOf<{
  'app-balance': { payload: { user: string }; response: { balance: number } };
}>();
expectTypeOf<ChatClaimed['channels']>().toEqualTypeOf<{
  'app-lobby': { incoming: { hello: { name: string } } };
}>();
expectTypeOf<ChatClaimed['errors']>().toEqualTypeOf<{ forbidden: { reason: string } }>();
expectTypeOf<keyof ChatClaimed['incoming']>().toEqualTypeOf<'app-notice'>();

// With no plugin claimed (the default), NOTHING is dropped — a prefix nobody owns
// stays reachable at the top level, exactly as before plugins existed.
type NoneClaimed = TopLevelContract<HostContract>;
expectTypeOf<keyof NoneClaimed['incoming']>().toEqualTypeOf<
  'app-notice' | '__acme:chat::message' | '__acme:chat::typing'
>();
expectTypeOf<keyof NoneClaimed['channels']>().toEqualTypeOf<'app-lobby' | '__acme:chat::room'>();

// A different plugin's claim leaves acme:chat's names in place.
type OtherClaimed = TopLevelContract<HostContract, 'acme:other'>;
expectTypeOf<keyof OtherClaimed['incoming']>().toEqualTypeOf<
  'app-notice' | '__acme:chat::message' | '__acme:chat::typing'
>();

// PluginSlice still pulls one plugin's names out for any id.
interface PlainContract {
  incoming: { tick: { n: number } };
  outgoing: { pong: {} };
}
expectTypeOf<PluginSlice<PlainContract, 'acme:chat'>['incoming']>().toEqualTypeOf<{}>();
