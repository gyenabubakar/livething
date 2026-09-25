import { isLiveThingConfigError, LiveThingConfigError } from '@livething/core';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import { describe, expect, it } from 'vitest';
import { channel, scope } from './channel.ts';

describe('scope() template compilation', () => {
  it('builds a declaration with key, template, compiled matcher, and param names', () => {
    const declaration = scope('rooms', 'room:{id}');
    expect(declaration.key).toBe('rooms');
    expect(declaration.template).toBe('room:{id}');
    expect(declaration.pattern).toBeInstanceOf(RegExp);
    expect(declaration.paramNames).toEqual(['id']);
  });

  it('matches a concrete name and captures the param', () => {
    const declaration = scope('rooms', 'room:{id}');
    const match = declaration.pattern.exec('room:alpha-42');
    expect(match).not.toBeNull();
    expect(match!.groups).toMatchObject({ id: 'alpha-42' });
  });

  it('a trailing param captures the rest, separators included', () => {
    const declaration = scope('rooms', 'room:{id}');
    expect(declaration.pattern.test('room:a:b:c')).toBe(true);
    expect(declaration.pattern.exec('room:a:b:c')!.groups!.id).toBe('a:b:c');
  });

  it('rejects a name that does not match the template', () => {
    const declaration = scope('rooms', 'room:{id}');
    expect(declaration.pattern.test('lobby:1')).toBe(false);
    expect(declaration.pattern.test('room:')).toBe(false); // {id} needs >= 1 char
  });

  it('supports multiple params separated by literals', () => {
    const declaration = scope('threads', 'org:{org}/thread:{tid}');
    expect(declaration.paramNames).toEqual(['org', 'tid']);
    const m = declaration.pattern.exec('org:acme/thread:42');
    expect(m!.groups).toMatchObject({ org: 'acme', tid: '42' });
  });

  it('rejects a malformed template (delegates to the parser)', () => {
    let thrown: unknown;
    try {
      scope('rooms', 'room:{id');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(LiveThingConfigError);
    expect(isLiveThingConfigError(thrown)).toBe(true);
  });

  it('names the base.channel() call, not an internal helper, in a template error', () => {
    const base = server({ capabilities: [channels()] });

    expect(() => base.channel(['rooms', 'room:{id'])).toThrow(
      `base.channel(['rooms', ...]) template "room:{id" has an unclosed '{'`,
    );
    expect(() => base.channel(['rooms', 'room:{id'])).not.toThrow(/scope\(\)/);
  });
});

describe('scope() / channel() empty-key rejection', () => {
  it('scope() throws when the key is the empty string', () => {
    expect(() => scope('', 'room:{id}')).toThrow(LiveThingConfigError);
  });

  it('scope() throws when the key is whitespace only', () => {
    expect(() => scope('   ', 'room:{id}')).toThrow(LiveThingConfigError);
  });

  it('channel() throws when the static channel name is the empty string', () => {
    expect(() => channel('')).toThrow(LiveThingConfigError);
  });

  it('channel() throws when the static channel name is whitespace only', () => {
    expect(() => channel('   ')).toThrow(LiveThingConfigError);
  });
});

describe('channel() rejects raw scope-shaped objects that bypass scope()', () => {
  it('rejects a hand-rolled object missing the compiled template', () => {
    expect(() =>
      channel({ key: 'rooms', pattern: /^room:.+$/ } as unknown as ReturnType<typeof scope>),
    ).toThrow(LiveThingConfigError);
  });

  it('rejects a hand-rolled object with an empty key', () => {
    expect(() =>
      channel({
        key: '',
        template: 'room:{id}',
        pattern: /^room:(.+?)$/,
        paramNames: ['id'],
      } as unknown as ReturnType<typeof scope>),
    ).toThrow(LiveThingConfigError);
  });

  it('rejects a hand-rolled object whose pattern is not a RegExp', () => {
    expect(() =>
      channel({
        key: 'rooms',
        template: 'room:{id}',
        pattern: 'not-a-regex',
        paramNames: ['id'],
      } as unknown as ReturnType<typeof scope>),
    ).toThrow(LiveThingConfigError);
  });

  it('accepts a declaration built through scope()', () => {
    expect(() => channel(scope('rooms', 'room:{id}'))).not.toThrow();
  });
});
