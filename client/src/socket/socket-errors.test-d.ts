// Type-only checks for the contract-typed `socket.onError`. tsc checks these;
// vitest never runs them.
import { WSKitError } from '@wskit/core';
import { client } from '~/client.ts';
import { connect } from '~/connect.ts';
import { expectTypeOf } from 'vitest';
import type { ContractError, UnrecognizedError } from '~/socket/api.ts';

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

// The handler sees the discriminated union of every declared error, a raw
// transport Event, or an UnrecognizedError for anything else a handler,
// primitive, or plugin threw — never a bare untyped WSKitError, and never a
// silent `unknown` that would let a developer assume a shape that isn't there.
type Handled = Parameters<Parameters<typeof socket.onError>[0]>[0];
expectTypeOf<Handled>().toEqualTypeOf<
  | WSKitError<'room-full', { limit: number }>
  | WSKitError<'kicked', { reason: string }>
  | WSKitError<'validation-failed', { path: string }>
  | Event
  | UnrecognizedError
>();

socket.onError((error) => {
  // The transport case is a plain Event, not a WSKitError.
  if (error instanceof Event) {
    expectTypeOf(error).toEqualTypeOf<Event>();
    return;
  }

  // Anything that isn't a WSKitError and isn't an Event is the catch-all —
  // proof the declared type doesn't quietly claim a shape for whatever a
  // handler, primitive, or plugin threw.
  if (!(error instanceof WSKitError)) {
    expectTypeOf(error).toEqualTypeOf<UnrecognizedError>();
    return;
  }

  // Narrowed to the error union: the code is the exact set of declared codes.
  // This is the case BUG 1 protects — adding the catch-all above must not
  // widen this back to a bare `string`.
  expectTypeOf(error.code).toEqualTypeOf<'room-full' | 'kicked' | 'validation-failed'>();

  // Switching on the code narrows the detail per case.
  switch (error.code) {
    case 'room-full':
      expectTypeOf(error.detail).toEqualTypeOf<{ limit: number }>();
      break;
    case 'kicked':
      expectTypeOf(error.detail).toEqualTypeOf<{ reason: string }>();
      break;
    case 'validation-failed':
      expectTypeOf(error.detail).toEqualTypeOf<{ path: string }>();
      break;
  }
});

// ContractError over a contract with no errors section is `never`, so onError
// then only hands back the transport Event.
type NoErrors = ContractError<{ incoming: { tick: {} } }>;
expectTypeOf<NoErrors>().toEqualTypeOf<never>();
