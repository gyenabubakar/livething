import { isWSKitConfigError, WSKitConfigError } from '@wskit/core';
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
    expect(thrown).toBeInstanceOf(WSKitConfigError);
    expect(isWSKitConfigError(thrown)).toBe(true);
    expect((thrown as Error).message).toMatch(/"g"/);
  });

  it('rejects the "y" (sticky) flag', () => {
    expect(() => scope('rooms', /^room-.+$/y)).toThrow(WSKitConfigError);
  });

  it('rejects regex with both "g" and "y"', () => {
    expect(() => scope('rooms', /^room-.+$/gy)).toThrow(WSKitConfigError);
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

describe('scope() catastrophic-backtracking guard', () => {
  it('rejects (a+)+ shape', () => {
    let thrown: unknown;
    try {
      scope('rooms', /^(a+)+b$/);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WSKitConfigError);
    expect((thrown as Error).message).toMatch(/nested unbounded quantifier/);
  });

  it('rejects (\\w+)+ shape', () => {
    expect(() => scope('rooms', /^(\w+)+\d$/)).toThrow(WSKitConfigError);
  });

  it('rejects (a*)* shape', () => {
    expect(() => scope('rooms', /^(a*)*b$/)).toThrow(WSKitConfigError);
  });

  it('rejects (a+)* shape', () => {
    expect(() => scope('rooms', /^(a+)*b$/)).toThrow(WSKitConfigError);
  });

  it('rejects (a*)+ shape', () => {
    expect(() => scope('rooms', /^(a*)+b$/)).toThrow(WSKitConfigError);
  });

  it('rejects (\\w+|x)+ shape', () => {
    expect(() => scope('rooms', /^(\w+|x)+\d$/)).toThrow(WSKitConfigError);
  });

  it('accepts a single bounded quantifier (a+)b', () => {
    expect(() => scope('rooms', /^(a+)b$/)).not.toThrow();
  });

  it('accepts patterns where the inner group has a + but the outer is not + or *', () => {
    expect(() => scope('rooms', /^(a+)?b$/)).not.toThrow();
  });

  it('accepts the documented family shape', () => {
    expect(() => scope('rooms', /^room:[a-z0-9-]+$/)).not.toThrow();
  });
});

describe('scope() / channel() empty-key rejection', () => {
  it('scope() throws when the key is the empty string', () => {
    expect(() => scope('', /^room-.+$/)).toThrow(WSKitConfigError);
  });

  it('scope() throws when the key is whitespace only', () => {
    expect(() => scope('   ', /^room-.+$/)).toThrow(WSKitConfigError);
  });

  it('channel() throws when the static channel name is the empty string', () => {
    expect(() => channel('')).toThrow(WSKitConfigError);
  });

  it('channel() throws when the static channel name is whitespace only', () => {
    expect(() => channel('   ')).toThrow(WSKitConfigError);
  });
});

describe('channel() rejects raw scope-shaped objects that bypass scope()', () => {
  it('rejects a hand-rolled object with the "g" flag', () => {
    expect(() => channel({ key: 'rooms', pattern: /^room-.+$/g })).toThrow(WSKitConfigError);
  });

  it('rejects a hand-rolled object with the "y" flag', () => {
    expect(() => channel({ key: 'rooms', pattern: /^room-.+$/y })).toThrow(WSKitConfigError);
  });

  it('rejects a hand-rolled object with an empty key', () => {
    expect(() => channel({ key: '', pattern: /^room-.+$/ })).toThrow(WSKitConfigError);
  });

  it('rejects a hand-rolled object whose pattern is not a RegExp', () => {
    expect(() => channel({ key: 'rooms', pattern: 'not-a-regex' as unknown as RegExp })).toThrow(
      WSKitConfigError,
    );
  });

  it('accepts a well-formed scope-shaped object', () => {
    expect(() => channel({ key: 'rooms', pattern: /^room-.+$/ })).not.toThrow();
  });
});
