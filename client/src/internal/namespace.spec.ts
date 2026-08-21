import { namespacedName } from '~/internal/namespace.ts';
import { describe, expect, it } from 'vitest';

describe('namespacedName', () => {
  it('wraps an id and name into the wire form', () => {
    expect(namespacedName('acme:chat', 'message')).toBe('__acme:chat::message');
  });

  it('works with an id that has no colon', () => {
    expect(namespacedName('metrics', 'tick')).toBe('__metrics::tick');
  });

  it('builds the bare prefix when the name is empty', () => {
    expect(namespacedName('feed', '')).toBe('__feed::');
  });
});
