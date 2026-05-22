import { describe, expectTypeOf, it } from 'vitest';
import type { StreamBroadcastClient } from './handler.ts';

describe('StreamBroadcastClient — no-any guard', () => {
  it('no slot is any', () => {
    expectTypeOf<StreamBroadcastClient['incoming']>().not.toBeAny();
    expectTypeOf<StreamBroadcastClient['outgoing']>().not.toBeAny();
    expectTypeOf<StreamBroadcastClient['requests']>().not.toBeAny();
    expectTypeOf<StreamBroadcastClient['streams']>().not.toBeAny();
    expectTypeOf<StreamBroadcastClient['channels']>().not.toBeAny();
    expectTypeOf<StreamBroadcastClient['namespaces']>().not.toBeAny();
    expectTypeOf<StreamBroadcastClient['errors']>().not.toBeAny();
  });
});

describe('StreamBroadcastClient — top-level streams', () => {
  it('has start-broadcast stream', () => {
    expectTypeOf<StreamBroadcastClient['streams']>().toHaveProperty('start-broadcast');
  });

  it('start-broadcast has correct payload and chunk', () => {
    expectTypeOf<StreamBroadcastClient['streams']['start-broadcast']['payload']>().toEqualTypeOf<{
      count: number;
    }>();
    expectTypeOf<StreamBroadcastClient['streams']['start-broadcast']['chunk']>().toEqualTypeOf<{
      index: number;
    }>();
  });

  it('start-broadcast has no cursor or nudges (broadcast does not surface in type)', () => {
    expectTypeOf<StreamBroadcastClient['streams']['start-broadcast']>().not.toHaveProperty(
      'cursor',
    );
    expectTypeOf<StreamBroadcastClient['streams']['start-broadcast']>().not.toHaveProperty(
      'nudges',
    );
    expectTypeOf<StreamBroadcastClient['streams']['start-broadcast']>().not.toHaveProperty(
      'broadcast',
    );
  });

  it('only start-broadcast in top-level streams', () => {
    expectTypeOf<keyof StreamBroadcastClient['streams']>().toEqualTypeOf<'start-broadcast'>();
  });
});

describe('StreamBroadcastClient — channels', () => {
  it('has rooms channel', () => {
    expectTypeOf<StreamBroadcastClient['channels']>().toHaveProperty('rooms');
  });

  it('rooms streams has start-room-broadcast', () => {
    expectTypeOf<StreamBroadcastClient['channels']['rooms']['streams']>().toHaveProperty(
      'start-room-broadcast',
    );
  });

  it('rooms streams has start-room-stream', () => {
    expectTypeOf<StreamBroadcastClient['channels']['rooms']['streams']>().toHaveProperty(
      'start-room-stream',
    );
  });

  it('start-room-broadcast has correct payload and chunk', () => {
    expectTypeOf<
      StreamBroadcastClient['channels']['rooms']['streams']['start-room-broadcast']['payload']
    >().toEqualTypeOf<{ count: number }>();
    expectTypeOf<
      StreamBroadcastClient['channels']['rooms']['streams']['start-room-broadcast']['chunk']
    >().toEqualTypeOf<{ index: number }>();
  });

  it('start-room-stream has correct payload and chunk', () => {
    expectTypeOf<
      StreamBroadcastClient['channels']['rooms']['streams']['start-room-stream']['payload']
    >().toEqualTypeOf<{ count: number }>();
    expectTypeOf<
      StreamBroadcastClient['channels']['rooms']['streams']['start-room-stream']['chunk']
    >().toEqualTypeOf<{ index: number }>();
  });

  it('no stream entry has broadcast key', () => {
    expectTypeOf<
      StreamBroadcastClient['channels']['rooms']['streams']['start-room-broadcast']
    >().not.toHaveProperty('broadcast');
    expectTypeOf<
      StreamBroadcastClient['channels']['rooms']['streams']['start-room-stream']
    >().not.toHaveProperty('broadcast');
  });

  it('rooms incoming and outgoing are empty', () => {
    expectTypeOf<keyof StreamBroadcastClient['channels']['rooms']['incoming']>().toBeNever();
    expectTypeOf<keyof StreamBroadcastClient['channels']['rooms']['outgoing']>().toBeNever();
  });
});

describe('StreamBroadcastClient — empty slots', () => {
  it('incoming is empty', () => {
    expectTypeOf<keyof StreamBroadcastClient['incoming']>().toBeNever();
  });

  it('outgoing is empty', () => {
    expectTypeOf<keyof StreamBroadcastClient['outgoing']>().toBeNever();
  });

  it('requests is empty', () => {
    expectTypeOf<keyof StreamBroadcastClient['requests']>().toBeNever();
  });

  it('namespaces is empty', () => {
    expectTypeOf<keyof StreamBroadcastClient['namespaces']>().toBeNever();
  });
});

describe('StreamBroadcastClient — builtin errors', () => {
  it('has all builtin error codes', () => {
    expectTypeOf<StreamBroadcastClient['errors']>().toHaveProperty('validation-failed');
    expectTypeOf<StreamBroadcastClient['errors']>().toHaveProperty('channel-not-found');
    expectTypeOf<StreamBroadcastClient['errors']>().toHaveProperty('channel-not-subscribed');
    expectTypeOf<StreamBroadcastClient['errors']>().toHaveProperty('namespace-not-found');
    expectTypeOf<StreamBroadcastClient['errors']>().toHaveProperty('internal-error');
  });
});
