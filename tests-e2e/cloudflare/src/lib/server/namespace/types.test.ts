import { describe, expectTypeOf, it } from 'vitest';
import type { NamespaceClient } from './handler.ts';

describe('NamespaceClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<NamespaceClient['incoming']>().not.toBeAny();
    expectTypeOf<NamespaceClient['outgoing']>().not.toBeAny();
    expectTypeOf<NamespaceClient['requests']>().not.toBeAny();
    expectTypeOf<NamespaceClient['streams']>().not.toBeAny();
    expectTypeOf<NamespaceClient['channels']>().not.toBeAny();
    expectTypeOf<NamespaceClient['namespaces']>().not.toBeAny();
    expectTypeOf<NamespaceClient['__errors__']>().not.toBeAny();
  });
});

describe('NamespaceClient — top-level slots are empty', () => {
  it('top-level incoming is empty', () => {
    expectTypeOf<keyof NamespaceClient['incoming']>().toBeNever();
  });

  it('top-level outgoing is empty', () => {
    expectTypeOf<keyof NamespaceClient['outgoing']>().toBeNever();
  });

  it('top-level requests is empty', () => {
    expectTypeOf<keyof NamespaceClient['requests']>().toBeNever();
  });

  it('top-level streams is empty', () => {
    expectTypeOf<keyof NamespaceClient['streams']>().toBeNever();
  });

  it('channels is empty', () => {
    expectTypeOf<keyof NamespaceClient['channels']>().toBeNever();
  });
});

describe('NamespaceClient — namespaces', () => {
  it('has ns namespace', () => {
    expectTypeOf<NamespaceClient['namespaces']>().toHaveProperty('ns');
  });

  it('ns incoming has ns-message (server outgoing → client receives)', () => {
    expectTypeOf<NamespaceClient['namespaces']['ns']['incoming']['ns-message']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('ns outgoing has send-ns (server incoming → client sends)', () => {
    expectTypeOf<NamespaceClient['namespaces']['ns']['outgoing']['send-ns']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('ns outgoing has broadcast-ns', () => {
    expectTypeOf<NamespaceClient['namespaces']['ns']['outgoing']['broadcast-ns']>().toEqualTypeOf<{
      text: string;
    }>();
  });

  it('ns requests has get-ns-info', () => {
    expectTypeOf<NamespaceClient['namespaces']['ns']['requests']>().toHaveProperty('get-ns-info');
  });

  it('get-ns-info has correct payload and response', () => {
    expectTypeOf<
      NamespaceClient['namespaces']['ns']['requests']['get-ns-info']['payload']
    >().toEqualTypeOf<{}>();
    expectTypeOf<
      NamespaceClient['namespaces']['ns']['requests']['get-ns-info']['response']
    >().toEqualTypeOf<{ namespace: string }>();
  });

  it('ns streams has start-ns-stream', () => {
    expectTypeOf<NamespaceClient['namespaces']['ns']['streams']>().toHaveProperty(
      'start-ns-stream',
    );
  });

  it('start-ns-stream has correct payload and chunk', () => {
    expectTypeOf<
      NamespaceClient['namespaces']['ns']['streams']['start-ns-stream']['payload']
    >().toEqualTypeOf<{ count: number }>();
    expectTypeOf<
      NamespaceClient['namespaces']['ns']['streams']['start-ns-stream']['chunk']
    >().toEqualTypeOf<{ index: number }>();
  });

  it('start-ns-stream has no cursor or nudges', () => {
    expectTypeOf<
      NamespaceClient['namespaces']['ns']['streams']['start-ns-stream']
    >().not.toHaveProperty('cursor');
    expectTypeOf<
      NamespaceClient['namespaces']['ns']['streams']['start-ns-stream']
    >().not.toHaveProperty('nudges');
    expectTypeOf<
      NamespaceClient['namespaces']['ns']['streams']['start-ns-stream']
    >().not.toHaveProperty('broadcast');
  });
});

describe('NamespaceClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<NamespaceClient['__errors__']>().toHaveProperty('validation-failed');
    expectTypeOf<NamespaceClient['__errors__']>().toHaveProperty('channel-not-found');
    expectTypeOf<NamespaceClient['__errors__']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<NamespaceClient['__errors__']>().toHaveProperty('namespace-not-found');
    expectTypeOf<NamespaceClient['__errors__']>().toHaveProperty('internal-error');
  });
});
