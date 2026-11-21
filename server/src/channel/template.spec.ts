import { LiveThingConfigError } from '@livething/core';
import { describe, expect, it } from 'vitest';
import { compileChannelTemplate } from './template.ts';

function match(template: string, name: string): Record<string, string> | null {
  const { regex } = compileChannelTemplate(template);
  const m = regex.exec(name);
  return m ? { ...m.groups } : null;
}

describe('compileChannelTemplate — valid templates', () => {
  it('single trailing param captures the rest', () => {
    const c = compileChannelTemplate('room:{id}');
    expect(c.paramNames).toEqual(['id']);
    expect(match('room:{id}', 'room:general')).toEqual({ id: 'general' });
    expect(match('room:{id}', 'room:a:b:c')).toEqual({ id: 'a:b:c' });
    expect(match('room:{id}', 'room:')).toBeNull(); // needs >= 1 char

    expect(match('room:{id}', 'lobby:1')).toBeNull();
  });

  it('a param matches line breaks too', () => {
    expect(match('room:{id}', 'room:a\nb c')).toEqual({ id: 'a\nb c' });
    expect(match('{type}:{id}', 'task-board:line\r\nbreak')).toEqual({
      type: 'task-board',
      id: 'line\r\nbreak',
    });
  });

  it('multiple params separated by literals match lazily', () => {
    const c = compileChannelTemplate('org:{org}/thread:{tid}');
    expect(c.paramNames).toEqual(['org', 'tid']);
    expect(match('org:{org}/thread:{tid}', 'org:acme/thread:42')).toEqual({
      org: 'acme',
      tid: '42',
    });
  });

  it('a paramless template matches its literal exactly', () => {
    const c = compileChannelTemplate('lobby');
    expect(c.paramNames).toEqual([]);
    expect(match('lobby', 'lobby')).toEqual({});
    expect(match('lobby', 'lobby2')).toBeNull();
  });

  it('treats regex metacharacters in literals as literal text', () => {
    expect(match('a.b+{id}', 'a.b+x')).toEqual({ id: 'x' });
    expect(match('a.b+{id}', 'aXb+x')).toBeNull(); // the '.' is literal, not "any char"
  });
});

describe('compileChannelTemplate — rejections', () => {
  it('rejects an empty template', () => {
    expect(() => compileChannelTemplate('')).toThrow(LiveThingConfigError);
  });

  it('rejects a stray { that is not part of a {param} capture', () => {
    for (const template of ['room:{id', 'cfg{{x}}:{id}', 'room:{{id}', 'room:{a{b}']) {
      expect(() => compileChannelTemplate(template)).toThrow(LiveThingConfigError);
      expect(() => compileChannelTemplate(template)).toThrow(
        /stray '\{' that is not part of a '\{param\}' capture/,
      );
    }
  });

  it('rejects a stray } that is not part of a {param} capture', () => {
    for (const template of ['room:id}', 'room:{id}}', 'cfg}}']) {
      expect(() => compileChannelTemplate(template)).toThrow(LiveThingConfigError);
      expect(() => compileChannelTemplate(template)).toThrow(
        /stray '\}' that is not part of a '\{param\}' capture/,
      );
    }
  });

  it('rejects an empty {}', () => {
    expect(() => compileChannelTemplate('room:{}')).toThrow(/empty/);
  });

  it('rejects an invalid param name', () => {
    expect(() => compileChannelTemplate('room:{id-x}')).toThrow(/invalid parameter name/);
    expect(() => compileChannelTemplate('room:{1id}')).toThrow(/invalid parameter name/);
  });

  it('rejects duplicate param names', () => {
    expect(() => compileChannelTemplate('{id}:{id}')).toThrow(/twice/);
  });

  it('rejects two params with no literal between them', () => {
    expect(() => compileChannelTemplate('{a}{b}')).toThrow(/no text between them/);
  });
});
