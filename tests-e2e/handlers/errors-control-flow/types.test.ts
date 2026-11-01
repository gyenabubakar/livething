import { describe, expectTypeOf, it } from 'vitest';
import type { ErrorsControlFlowClient } from './handler.ts';

describe('ErrorsControlFlowClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ErrorsControlFlowClient['incoming']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['outgoing']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['errors']>().not.toBeAny();
  });
});

describe('ErrorsControlFlowClient — incoming (server outgoing)', () => {
  it('has echoed', () => {
    expectTypeOf<ErrorsControlFlowClient['incoming']['echoed']>().toEqualTypeOf<{ text: string }>();
  });

  it('has block-reply', () => {
    expectTypeOf<ErrorsControlFlowClient['incoming']['block-reply']>().toEqualTypeOf<{
      leaked: boolean;
    }>();
  });

  it('has validation-error-fired', () => {
    expectTypeOf<ErrorsControlFlowClient['incoming']['validation-error-fired']>().toEqualTypeOf<{
      event: string;
    }>();
  });

  it('exactly three events in incoming', () => {
    expectTypeOf<keyof ErrorsControlFlowClient['incoming']>().toEqualTypeOf<
      'echoed' | 'block-reply' | 'validation-error-fired'
    >();
  });
});

describe('ErrorsControlFlowClient — outgoing (server incoming)', () => {
  it('has do-echo', () => {
    expectTypeOf<ErrorsControlFlowClient['outgoing']['do-echo']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('has block-test with empty payload', () => {
    expectTypeOf<ErrorsControlFlowClient['outgoing']['block-test']>().toEqualTypeOf<{}>();
  });

  it('has manual-validation with empty payload', () => {
    expectTypeOf<ErrorsControlFlowClient['outgoing']['manual-validation']>().toEqualTypeOf<{}>();
  });

  it('has force-disconnect with empty payload', () => {
    expectTypeOf<ErrorsControlFlowClient['outgoing']['force-disconnect']>().toEqualTypeOf<{}>();
  });
});

describe('ErrorsControlFlowClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ErrorsControlFlowClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ErrorsControlFlowClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ErrorsControlFlowClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ErrorsControlFlowClient['errors']>().toHaveProperty('internal-error');
  });
});
