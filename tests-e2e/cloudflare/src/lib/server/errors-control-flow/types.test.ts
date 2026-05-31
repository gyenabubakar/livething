import { describe, expectTypeOf, it } from 'vitest';
import type { ErrorsControlFlowClient } from './handler.ts';

describe('ErrorsControlFlowClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<ErrorsControlFlowClient['incoming']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['outgoing']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['requests']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['streams']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['channels']>().not.toBeAny();
    expectTypeOf<ErrorsControlFlowClient['namespaces']>().not.toBeAny();
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

  it('has defer-result', () => {
    expectTypeOf<ErrorsControlFlowClient['incoming']['defer-result']>().toEqualTypeOf<{
      received: boolean;
    }>();
  });

  it('has defer-exhausted-result', () => {
    expectTypeOf<ErrorsControlFlowClient['incoming']['defer-exhausted-result']>().toEqualTypeOf<{
      event: string;
      retries: number;
    }>();
  });

  it('has validation-error-fired', () => {
    expectTypeOf<ErrorsControlFlowClient['incoming']['validation-error-fired']>().toEqualTypeOf<{
      event: string;
    }>();
  });

  it('exactly five events in incoming', () => {
    expectTypeOf<keyof ErrorsControlFlowClient['incoming']>().toEqualTypeOf<
      | 'echoed'
      | 'block-reply'
      | 'defer-result'
      | 'defer-exhausted-result'
      | 'validation-error-fired'
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

  it('has defer-test with empty payload', () => {
    expectTypeOf<ErrorsControlFlowClient['outgoing']['defer-test']>().toEqualTypeOf<{}>();
  });

  it('has always-defer with empty payload', () => {
    expectTypeOf<ErrorsControlFlowClient['outgoing']['always-defer']>().toEqualTypeOf<{}>();
  });

  it('has manual-validation with empty payload', () => {
    expectTypeOf<ErrorsControlFlowClient['outgoing']['manual-validation']>().toEqualTypeOf<{}>();
  });

  it('has force-disconnect with empty payload', () => {
    expectTypeOf<ErrorsControlFlowClient['outgoing']['force-disconnect']>().toEqualTypeOf<{}>();
  });
});

describe('ErrorsControlFlowClient — streams', () => {
  it('has start-defer-stream', () => {
    expectTypeOf<ErrorsControlFlowClient['streams']>().toHaveProperty('start-defer-stream');
  });

  it('start-defer-stream has correct payload and chunk', () => {
    expectTypeOf<
      ErrorsControlFlowClient['streams']['start-defer-stream']['payload']
    >().toEqualTypeOf<{}>();
    expectTypeOf<
      ErrorsControlFlowClient['streams']['start-defer-stream']['chunk']
    >().toEqualTypeOf<{
      index: number;
    }>();
  });

  it('start-defer-stream has no cursor or nudges', () => {
    expectTypeOf<ErrorsControlFlowClient['streams']['start-defer-stream']>().not.toHaveProperty(
      'cursor',
    );
    expectTypeOf<ErrorsControlFlowClient['streams']['start-defer-stream']>().not.toHaveProperty(
      'nudges',
    );
    expectTypeOf<ErrorsControlFlowClient['streams']['start-defer-stream']>().not.toHaveProperty(
      'broadcast',
    );
  });
});

describe('ErrorsControlFlowClient — stream resumable flags', () => {
  it('start-defer-stream is not resumable', () => {
    expectTypeOf<
      ErrorsControlFlowClient['streams']['start-defer-stream']['resumable']
    >().toEqualTypeOf<false>();
  });
});

describe('ErrorsControlFlowClient — channels', () => {
  it('has chat channel', () => {
    expectTypeOf<ErrorsControlFlowClient['channels']>().toHaveProperty('chat');
  });

  it('chat channel outgoing has chat-always-defer (server incoming)', () => {
    expectTypeOf<
      ErrorsControlFlowClient['channels']['chat']['outgoing']['chat-always-defer']
    >().toEqualTypeOf<{}>();
  });

  it('chat channel incoming is empty (no server outgoing in chat)', () => {
    expectTypeOf<keyof ErrorsControlFlowClient['channels']['chat']['incoming']>().toBeNever();
  });
});

describe('ErrorsControlFlowClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<ErrorsControlFlowClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<ErrorsControlFlowClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<ErrorsControlFlowClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<ErrorsControlFlowClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<ErrorsControlFlowClient['errors']>().toHaveProperty('internal-error');
  });
});
