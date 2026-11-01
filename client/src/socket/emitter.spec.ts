import { Emitter } from '~/socket/emitter.ts';
import { describe, expect, it } from 'vitest';

type Events = {
  open: [];
  message: [data: string];
  close: [code: number];
};

describe('Emitter.listenerCount', () => {
  it('returns 0 for an event with no listeners', () => {
    const emitter = new Emitter<Events>();
    expect(emitter.listenerCount('open')).toBe(0);
  });

  it('returns 1 after one listener is added', () => {
    const emitter = new Emitter<Events>();
    emitter.on('open', () => {});
    expect(emitter.listenerCount('open')).toBe(1);
  });

  it('returns the correct count when multiple listeners are added to one event', () => {
    const emitter = new Emitter<Events>();
    emitter.on('message', () => {});
    emitter.on('message', () => {});
    emitter.on('message', () => {});
    expect(emitter.listenerCount('message')).toBe(3);
  });

  it('returns 0 for an unrelated event when another event has listeners', () => {
    const emitter = new Emitter<Events>();
    emitter.on('open', () => {});
    expect(emitter.listenerCount('close')).toBe(0);
  });

  it('decrements by 1 after a listener is removed via the unsubscribe function', () => {
    const emitter = new Emitter<Events>();
    emitter.on('message', () => {});
    const unsub = emitter.on('message', () => {});
    expect(emitter.listenerCount('message')).toBe(2);
    unsub();

    expect(emitter.listenerCount('message')).toBe(1);
  });

  it('returns 0 after the last listener for an event is removed', () => {
    const emitter = new Emitter<Events>();
    const unsub = emitter.on('open', () => {});
    unsub();
    expect(emitter.listenerCount('open')).toBe(0);
  });
});

describe('Emitter.emit — mid-emit mutation isolation', () => {
  it('a listener added inside another listener during emit must not run in the same emit cycle', () => {
    const emitter = new Emitter<Events>();
    let fn2CallCount = 0;

    emitter.on('open', () => {
      emitter.on('open', () => {
        fn2CallCount++;
      });
    });

    // First emit: only the original listener should run; fn2 must NOT be called yet.
    emitter.emit('open');
    expect(fn2CallCount).toBe(0);

    emitter.emit('open');
    expect(fn2CallCount).toBe(1);
  });
});
