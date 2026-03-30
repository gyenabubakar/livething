import { Emitter } from '@/socket/emitter.ts';
import { describe, expect, it, vi } from 'vitest';

type TestEvents = {
  message: [text: string, from: string];
  close: [code: number];
  ping: [];
};

describe('Emitter', () => {
  it('calls listener when event is emitted', () => {
    const emitter = new Emitter<TestEvents>();
    const listener = vi.fn();

    emitter.on('message', listener);
    emitter.emit('message', 'hello', 'alice');

    expect(listener).toHaveBeenCalledWith('hello', 'alice');
  });

  it('supports multiple listeners for the same event', () => {
    const emitter = new Emitter<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();

    emitter.on('message', a);
    emitter.on('message', b);
    emitter.emit('message', 'hi', 'bob');

    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('does not call listeners for other events', () => {
    const emitter = new Emitter<TestEvents>();
    const messageListener = vi.fn();
    const closeListener = vi.fn();

    emitter.on('message', messageListener);
    emitter.on('close', closeListener);
    emitter.emit('message', 'hi', 'bob');

    expect(messageListener).toHaveBeenCalledOnce();
    expect(closeListener).not.toHaveBeenCalled();
  });

  it('returns an unsubscribe function', () => {
    const emitter = new Emitter<TestEvents>();
    const listener = vi.fn();

    const unsub = emitter.on('message', listener);
    unsub();
    emitter.emit('message', 'hi', 'bob');

    expect(listener).not.toHaveBeenCalled();
  });

  it('calling unsubscribe twice is safe', () => {
    const emitter = new Emitter<TestEvents>();
    const unsub = emitter.on('message', vi.fn());

    unsub();
    expect(() => unsub()).not.toThrow();
  });

  it('does not crash when emitting with no listeners', () => {
    const emitter = new Emitter<TestEvents>();
    expect(() => emitter.emit('message', 'hi', 'bob')).not.toThrow();
  });

  it('supports zero-arg events', () => {
    const emitter = new Emitter<TestEvents>();
    const listener = vi.fn();

    emitter.on('ping', listener);
    emitter.emit('ping');

    expect(listener).toHaveBeenCalledWith();
  });

  it('clear removes all listeners', () => {
    const emitter = new Emitter<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();

    emitter.on('message', a);
    emitter.on('close', b);
    emitter.clear();

    emitter.emit('message', 'hi', 'bob');
    emitter.emit('close', 1000);

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('listenerCount returns correct count', () => {
    const emitter = new Emitter<TestEvents>();

    expect(emitter.listenerCount('message')).toBe(0);

    const unsub1 = emitter.on('message', vi.fn());
    emitter.on('message', vi.fn());

    expect(emitter.listenerCount('message')).toBe(2);

    unsub1();
    expect(emitter.listenerCount('message')).toBe(1);
  });

  it('unsubscribing one listener does not affect others', () => {
    const emitter = new Emitter<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();

    const unsubA = emitter.on('message', a);
    emitter.on('message', b);

    unsubA();
    emitter.emit('message', 'hi', 'bob');

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  it('listeners fire in registration order', () => {
    const emitter = new Emitter<TestEvents>();
    const order: number[] = [];

    emitter.on('ping', () => order.push(1));
    emitter.on('ping', () => order.push(2));
    emitter.on('ping', () => order.push(3));

    emitter.emit('ping');

    expect(order).toEqual([1, 2, 3]);
  });

  it('cleans up empty listener sets after unsubscribe', () => {
    const emitter = new Emitter<TestEvents>();
    const unsub = emitter.on('message', vi.fn());

    expect(emitter.listenerCount('message')).toBe(1);

    unsub();
    expect(emitter.listenerCount('message')).toBe(0);
  });
});
