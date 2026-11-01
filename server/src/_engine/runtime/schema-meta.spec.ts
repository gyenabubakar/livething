import { readSchemaState } from '~/_engine/runtime/schema-meta.ts';
import { describe, expect, it } from 'vitest';

function sqlThatThrows(message: string) {
  return {
    exec() {
      throw new Error(message);
    },
  };
}

describe('readSchemaState', () => {
  it('reports a fresh database when the meta table is missing', () => {
    expect(readSchemaState(sqlThatThrows('no such table: __livething_meta'))).toEqual({
      fresh: true,
    });
  });

  it('propagates any other storage error instead of masquerading as fresh', () => {
    expect(() => readSchemaState(sqlThatThrows('disk I/O error'))).toThrow('disk I/O error');
  });

  it('reports not fresh once the meta table is present', () => {
    const sql = {
      exec: () => ({ toArray: () => [{ value: '1' }] }),
    } as unknown as Parameters<typeof readSchemaState>[0];
    expect(readSchemaState(sql)).toEqual({ fresh: false });
  });

  it('reports not fresh even when the meta table is present but empty', () => {
    const sql = {
      exec: () => ({ toArray: () => [] }),
    } as unknown as Parameters<typeof readSchemaState>[0];
    expect(readSchemaState(sql)).toEqual({ fresh: false });
  });
});
