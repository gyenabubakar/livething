import { namespacedName, parseNamespaced } from '~/internal/namespace.ts';
import { describe, expect, it } from 'vitest';

describe('namespacedName', () => {
  it('wraps an id and name into the wire form', () => {
    expect(namespacedName('acme:chat', 'message')).toBe('__acme:chat::message');
  });

  it('works with an id that has no colon', () => {
    expect(namespacedName('metrics', 'tick')).toBe('__metrics::tick');
  });
});

describe('parseNamespaced', () => {
  it('splits a wire name back into id and name', () => {
    expect(parseNamespaced('__acme:chat::message')).toEqual({ id: 'acme:chat', name: 'message' });
  });

  it('keeps the colon inside a two-part id', () => {
    expect(parseNamespaced('__acme:chat::send-message')).toEqual({
      id: 'acme:chat',
      name: 'send-message',
    });
  });

  it('round-trips with namespacedName', () => {
    const wire = namespacedName('acme:chat', 'reaction');
    expect(parseNamespaced(wire)).toEqual({ id: 'acme:chat', name: 'reaction' });
  });

  it('returns null for a plain event', () => {
    expect(parseNamespaced('message')).toBeNull();
  });

  it('returns null for a bare protocol frame with no delimiter', () => {
    expect(parseNamespaced('__error__')).toBeNull();
  });

  it('returns null for a name that does not start with two underscores', () => {
    expect(parseNamespaced('acme:chat::message')).toBeNull();
  });
});
