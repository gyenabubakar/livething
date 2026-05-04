import { isWskitConfigError, WskitConfigError } from '@wskit/core';
import { describe, expect, it } from 'vitest';
import { channel, scope } from './channel.ts';

describe('scope() regex flag validation', () => {
  it('rejects the "g" (global) flag', () => {
    let thrown: unknown;
    try {
      scope('rooms', /^room-.+$/g);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WskitConfigError);
    expect(isWskitConfigError(thrown)).toBe(true);
    expect((thrown as Error).message).toMatch(/"g"/);
  });

  it('rejects the "y" (sticky) flag', () => {
    expect(() => scope('rooms', /^room-.+$/y)).toThrow(WskitConfigError);
  });

  it('rejects regex with both "g" and "y"', () => {
    expect(() => scope('rooms', /^room-.+$/gy)).toThrow(WskitConfigError);
  });

  it('accepts the "i" (case-insensitive) flag', () => {
    expect(() => scope('rooms', /^room-.+$/i)).not.toThrow();
  });

  it('accepts "m" and "s" flags', () => {
    expect(() => scope('rooms', /^room-.+$/m)).not.toThrow();
    expect(() => scope('rooms', /^room-.+$/s)).not.toThrow();
  });

  it('accepts a flag-free regex', () => {
    const result = scope('rooms', /^room-.+$/);
    expect(result).toEqual({ key: 'rooms', pattern: /^room-.+$/ });
  });
});

describe('scope() / channel() empty-key rejection', () => {
  it('scope() throws when the key is the empty string', () => {
    expect(() => scope('', /^room-.+$/)).toThrow(WskitConfigError);
  });

  it('scope() throws when the key is whitespace only', () => {
    expect(() => scope('   ', /^room-.+$/)).toThrow(WskitConfigError);
  });

  it('channel() throws when the static channel name is the empty string', () => {
    expect(() => channel('')).toThrow(WskitConfigError);
  });

  it('channel() throws when the static channel name is whitespace only', () => {
    expect(() => channel('   ')).toThrow(WskitConfigError);
  });
});

describe('channel() rejects raw scope-shaped objects that bypass scope()', () => {
  it('rejects a hand-rolled object with the "g" flag', () => {
    expect(() => channel({ key: 'rooms', pattern: /^room-.+$/g })).toThrow(WskitConfigError);
  });

  it('rejects a hand-rolled object with the "y" flag', () => {
    expect(() => channel({ key: 'rooms', pattern: /^room-.+$/y })).toThrow(WskitConfigError);
  });

  it('rejects a hand-rolled object with an empty key', () => {
    expect(() => channel({ key: '', pattern: /^room-.+$/ })).toThrow(WskitConfigError);
  });

  it('rejects a hand-rolled object whose pattern is not a RegExp', () => {
    expect(() => channel({ key: 'rooms', pattern: 'not-a-regex' as unknown as RegExp })).toThrow(
      WskitConfigError,
    );
  });

  it('accepts a well-formed scope-shaped object', () => {
    expect(() => channel({ key: 'rooms', pattern: /^room-.+$/ })).not.toThrow();
  });
});
