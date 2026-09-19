// Type-only checks for the socket error and contract utility types. tsc checks these;
// vitest never runs them.
import { ConnectionBusy, RateLimited } from '@livething/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { expectTypeOf } from 'vitest';
import type { LiveThingError as LiveThingErrorType } from '@livething/core';
import type { ContractError } from '~/socket/api.ts';

// A contract shaped like `InferClient` output: the framework's built-in errors
// (always present) alongside the app's own declared errors.
interface AppContract {
  incoming: { message: { text: string } };
  errors: {
    'room-full': { limit: number };
    kicked: { reason: string };
    'validation-failed': { path: string }; // a built-in, folded in by InferClient
  };
}

const socket = client<AppContract>()(connect('wss://example.com'));

// The runtime callback is honest about all values that can reach onError.
type Handled = Parameters<Parameters<typeof socket.onError>[0]>[0];
expectTypeOf<Handled>().toEqualTypeOf<unknown>();

// The declared members retain their code/detail pairing for extraction and
// editor tooling.
type RoomFull = Extract<ContractError<AppContract>, { code: 'room-full' }>;
type Kicked = Extract<ContractError<AppContract>, { code: 'kicked' }>;
type ValidationFailed = Extract<ContractError<AppContract>, { code: 'validation-failed' }>;
expectTypeOf<RoomFull>().toEqualTypeOf<LiveThingErrorType<'room-full', { limit: number }>>();
expectTypeOf<Kicked>().toEqualTypeOf<LiveThingErrorType<'kicked', { reason: string }>>();
expectTypeOf<ValidationFailed>().toEqualTypeOf<
  LiveThingErrorType<'validation-failed', { path: string }>
>();

socket.onError((error) => {
  // The transport case is a plain Event, not a LiveThingError.
  if (error instanceof Event) {
    expectTypeOf(error).toEqualTypeOf<Event>();
    return;
  }

  // The callback can also receive arbitrary thrown values. ContractError
  // remains available as a utility type, but runtime narrowing uses the
  // matching error definition rather than assuming this callback is typed.
  if (RateLimited.matches(error)) {
    expectTypeOf(error.detail).toEqualTypeOf<{ retryAfterMs: number }>();
  }

  if (ConnectionBusy.matches(error)) {
    expectTypeOf(error.detail).toEqualTypeOf<{ retryAfterMs: number }>();
  }
});

socket.onServerError((error) => {
  expectTypeOf(error).toEqualTypeOf<LiveThingErrorType<string, unknown>>();
});

socket.onServerError('room-full', (error) => {
  expectTypeOf(error).toEqualTypeOf<LiveThingErrorType<'room-full', { limit: number }>>();
  expectTypeOf(error.detail.limit).toEqualTypeOf<number>();
});

// @ts-expect-error — code-specific subscriptions only accept declared contract codes
socket.onServerError('not-declared', () => {});

// A hand-written contract with no errors section has no typed server errors.
type NoErrors = ContractError<{ incoming: { tick: {} } }>;
expectTypeOf<NoErrors>().toEqualTypeOf<never>();
