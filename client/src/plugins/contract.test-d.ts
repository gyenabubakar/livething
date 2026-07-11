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

type AppOnly = TopLevelContract<HostContract>;

// The top-level contract keeps the app's names and drops every plugin name.
expectTypeOf<AppOnly['incoming']>().toEqualTypeOf<{ 'app-notice': { text: string } }>();
expectTypeOf<AppOnly['outgoing']>().toEqualTypeOf<{ 'app-ping': { at: number } }>();
expectTypeOf<AppOnly['requests']>().toEqualTypeOf<{
  'app-balance': { payload: { user: string }; response: { balance: number } };
}>();
expectTypeOf<AppOnly['channels']>().toEqualTypeOf<{
  'app-lobby': { incoming: { hello: { name: string } } };
}>();
expectTypeOf<AppOnly['errors']>().toEqualTypeOf<{ forbidden: { reason: string } }>();

// No plugin name survives at the top level.
expectTypeOf<keyof AppOnly['incoming']>().toEqualTypeOf<'app-notice'>();

// A contract with no plugin names is left whole at the top level and yields an
// empty slice for any id.
interface PlainContract {
  incoming: { tick: { n: number } };
  outgoing: { pong: {} };
}
expectTypeOf<TopLevelContract<PlainContract>['incoming']>().toEqualTypeOf<{
  tick: { n: number };
}>();
expectTypeOf<PluginSlice<PlainContract, 'acme:chat'>['incoming']>().toEqualTypeOf<{}>();
