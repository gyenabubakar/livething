import { describe, expectTypeOf, it } from 'vitest';
import type { CtxTagsClient } from './handler.ts';

describe('CtxTagsClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<CtxTagsClient['incoming']>().not.toBeAny();
    expectTypeOf<CtxTagsClient['outgoing']>().not.toBeAny();
    expectTypeOf<CtxTagsClient['requests']>().not.toBeAny();
    expectTypeOf<CtxTagsClient['streams']>().not.toBeAny();
    expectTypeOf<CtxTagsClient['channels']>().not.toBeAny();
    expectTypeOf<CtxTagsClient['namespaces']>().not.toBeAny();
    expectTypeOf<CtxTagsClient['errors']>().not.toBeAny();
  });
});

describe('CtxTagsClient — incoming (server outgoing)', () => {
  it('has tag-result', () => {
    expectTypeOf<CtxTagsClient['incoming']['tag-result']>().toEqualTypeOf<{ tags: string }>();
  });

  it('has connection-info', () => {
    expectTypeOf<CtxTagsClient['incoming']['connection-info']>().toEqualTypeOf<{ count: number }>();
  });

  it('has connections-by-tag-result', () => {
    expectTypeOf<CtxTagsClient['incoming']['connections-by-tag-result']>().toEqualTypeOf<{
      tag: string;
      count: number;
    }>();
  });

  it('exactly three events in incoming', () => {
    expectTypeOf<keyof CtxTagsClient['incoming']>().toEqualTypeOf<
      'tag-result' | 'connection-info' | 'connections-by-tag-result'
    >();
  });
});

describe('CtxTagsClient — outgoing (server incoming)', () => {
  it('has tag-self', () => {
    expectTypeOf<CtxTagsClient['outgoing']['tag-self']>().toEqualTypeOf<{ tag: string }>();
  });

  it('has untag-self', () => {
    expectTypeOf<CtxTagsClient['outgoing']['untag-self']>().toEqualTypeOf<{ tag: string }>();
  });

  it('has get-my-tags with empty payload', () => {
    expectTypeOf<CtxTagsClient['outgoing']['get-my-tags']>().toEqualTypeOf<{}>();
  });

  it('has get-connection-info with empty payload', () => {
    expectTypeOf<CtxTagsClient['outgoing']['get-connection-info']>().toEqualTypeOf<{}>();
  });

  it('has get-by-tag', () => {
    expectTypeOf<CtxTagsClient['outgoing']['get-by-tag']>().toEqualTypeOf<{ tag: string }>();
  });

  it('exactly five events in outgoing', () => {
    expectTypeOf<keyof CtxTagsClient['outgoing']>().toEqualTypeOf<
      'tag-self' | 'untag-self' | 'get-my-tags' | 'get-connection-info' | 'get-by-tag'
    >();
  });
});

describe('CtxTagsClient — empty slots', () => {
  it('requests is empty', () => {
    expectTypeOf<keyof CtxTagsClient['requests']>().toBeNever();
  });

  it('streams is empty', () => {
    expectTypeOf<keyof CtxTagsClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof CtxTagsClient['channels']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof CtxTagsClient['namespaces']>().toBeNever();
  });
});

describe('CtxTagsClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<CtxTagsClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<CtxTagsClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<CtxTagsClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<CtxTagsClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<CtxTagsClient['errors']>().toHaveProperty('internal-error');
  });
});
