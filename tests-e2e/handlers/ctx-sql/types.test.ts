import { describe, expectTypeOf, it } from 'vitest';
import type { CtxSqlClient } from './handler.ts';

describe('CtxSqlClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<CtxSqlClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxSqlClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxSqlClient['clientRequests']>().not.toBeAny();
    expectTypeOf<CtxSqlClient['streams']>().not.toBeAny();
    expectTypeOf<CtxSqlClient['channels']>().not.toBeAny();

    expectTypeOf<CtxSqlClient['errors']>().not.toBeAny();
  });
});

describe('CtxSqlClient — incoming (server outgoing)', () => {
  it('has notes-list', () => {
    expectTypeOf<CtxSqlClient['incoming']['notes-list']>().toEqualTypeOf<{
      notes: Array<{ id: number; title: string; body: string }>;
    }>();
  });

  it('has sql-one-result', () => {
    expectTypeOf<CtxSqlClient['incoming']['sql-one-result']>().toEqualTypeOf<{
      row: { c: number } | null;
    }>();
  });

  it('has sql-one-empty-result', () => {
    expectTypeOf<CtxSqlClient['incoming']['sql-one-empty-result']>().toEqualTypeOf<{
      row: { c: number } | null;
    }>();
  });

  it('has sql-raw-result', () => {
    expectTypeOf<CtxSqlClient['incoming']['sql-raw-result']>().toEqualTypeOf<{
      rows: unknown[][];
    }>();
  });

  it('has sql-reuse-result', () => {
    expectTypeOf<CtxSqlClient['incoming']['sql-reuse-result']>().toEqualTypeOf<{ error: string }>();
  });

  it('has the declared incoming events', () => {
    expectTypeOf<keyof CtxSqlClient['incoming']>().toEqualTypeOf<
      | 'notes-list'
      | 'sql-one-result'
      | 'sql-one-empty-result'
      | 'sql-raw-result'
      | 'sql-reuse-result'
      | 'snapshot-result'
    >();
  });
});

describe('CtxSqlClient — outgoing (server incoming)', () => {
  it('has save-note', () => {
    expectTypeOf<CtxSqlClient['outgoing']['save-note']>().toEqualTypeOf<{
      title: string;
      body: string;
    }>();
  });

  it('has get-notes with empty payload', () => {
    expectTypeOf<CtxSqlClient['outgoing']['get-notes']>().toEqualTypeOf<{}>();
  });

  it('has sql-one-probe with empty payload', () => {
    expectTypeOf<CtxSqlClient['outgoing']['sql-one-probe']>().toEqualTypeOf<{}>();
  });

  it('has sql-one-empty-probe with empty payload', () => {
    expectTypeOf<CtxSqlClient['outgoing']['sql-one-empty-probe']>().toEqualTypeOf<{}>();
  });

  it('has sql-raw-probe with empty payload', () => {
    expectTypeOf<CtxSqlClient['outgoing']['sql-raw-probe']>().toEqualTypeOf<{}>();
  });

  it('has sql-reuse-probe with empty payload', () => {
    expectTypeOf<CtxSqlClient['outgoing']['sql-reuse-probe']>().toEqualTypeOf<{}>();
  });
});

describe('CtxSqlClient — empty slots', () => {
  it('clientRequests is empty', () => {
    expectTypeOf<keyof CtxSqlClient['clientRequests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof CtxSqlClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof CtxSqlClient['channels']>().toBeNever();
  });
});

describe('CtxSqlClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<CtxSqlClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<CtxSqlClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<CtxSqlClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<CtxSqlClient['errors']>().toHaveProperty('internal-error');
  });
});
