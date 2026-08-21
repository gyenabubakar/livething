import { createStore } from '~/internal/store.ts';
import { bench, describe } from 'vitest';

function storeWith(listenerCount: number) {
  const writable = createStore<number>(0);
  let sink = 0;
  for (let i = 0; i < listenerCount; i++) writable.store.subscribe(() => void sink++);
  return writable;
}

// Connection state, connection quality, channel status and member lists are all
// stores. A framework binding usually holds exactly one listener per store.
describe('store.set · 100k changes', () => {
  const none = storeWith(0);
  const one = storeWith(1);
  const eight = storeWith(8);

  bench('no listener', () => {
    for (let i = 0; i < 100_000; i++) none.set(i);
  });

  bench('one listener', () => {
    for (let i = 0; i < 100_000; i++) one.set(i);
  });

  bench('eight listeners', () => {
    for (let i = 0; i < 100_000; i++) eight.set(i);
  });

  bench('unchanged value (no-op)', () => {
    for (let i = 0; i < 100_000; i++) one.set(0);
  });
});
