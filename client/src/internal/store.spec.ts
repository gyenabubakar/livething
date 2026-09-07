import { createStore } from '~/internal/store.ts';
import { describe, expect, it, vi } from 'vitest';

describe('createStore — reading the value', () => {
  it('get() returns the initial value', () => {
    const { store } = createStore(1);
    expect(store.get()).toBe(1);
  });

  it('get() returns the latest value after a change', () => {
    const { store, set } = createStore(1);
    set(2);
    expect(store.get()).toBe(2);
  });

  it('keeps the same reference until the value actually changes', () => {
    const first = { count: 0 };
    const second = { count: 1 };
    const { store, set } = createStore(first);

    expect(store.get()).toBe(first);
    set(second);
    expect(store.get()).toBe(second);
  });
});

describe('createStore — subscribing to changes', () => {
  it('runs the listener with the new value on every change', () => {
    const { store, set } = createStore(0);
    const listener = vi.fn();
    store.subscribe(listener);

    set(1);
    set(2);

    expect(listener.mock.calls).toEqual([[1], [2]]);
  });

  it('does not fire the listener immediately on subscribe', () => {
    const { store } = createStore('start');
    const listener = vi.fn();
    store.subscribe(listener);

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops calling a listener once its unsubscribe has run', () => {
    const { store, set } = createStore(0);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    set(1);
    unsubscribe();
    set(2);

    expect(listener.mock.calls).toEqual([[1]]);
  });

  it('notifies every current listener on a change', () => {
    const { store, set } = createStore(0);
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe(first);
    store.subscribe(second);

    set(1);

    expect(first).toHaveBeenCalledWith(1);
    expect(second).toHaveBeenCalledWith(1);
  });
});

describe('createStore — an unchanged set is a no-op', () => {
  it('does not fire listeners when the value is the same by Object.is', () => {
    const { store, set } = createStore(5);
    const listener = vi.fn();
    store.subscribe(listener);

    set(5);

    expect(listener).not.toHaveBeenCalled();
  });

  it('treats the same object reference as unchanged', () => {
    const value = { id: 'a' };
    const { store, set } = createStore(value);
    const listener = vi.fn();
    store.subscribe(listener);

    set(value);

    expect(listener).not.toHaveBeenCalled();
    expect(store.get()).toBe(value);
  });
});

describe('createStore — a throwing listener is isolated and reported', () => {
  it('lets the other listeners run and passes the error to onListenerError', () => {
    const onListenerError = vi.fn();
    const boom = new Error('listener boom');
    const { store, set } = createStore(0, onListenerError);
    const survivor = vi.fn();
    store.subscribe(() => {
      throw boom;
    });

    store.subscribe(survivor);

    set(1);

    expect(survivor).toHaveBeenCalledWith(1);
    expect(onListenerError).toHaveBeenCalledWith(boom);
  });

  it('does not let a throwing listener escape set() when no reporter is given', () => {
    const { store, set } = createStore(0);
    store.subscribe(() => {
      throw new Error('listener boom');
    });

    expect(() => set(1)).not.toThrow();
    expect(store.get()).toBe(1);
  });
});
