/* oxlint-disable @typescript-eslint/no-explicit-any */
import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { channels } from '~/channel/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { resumableStream } from './capability.ts';
import { compileResumableStreamDef } from './compile.ts';
import { resumableStream as resumableStreamDef } from './definition.ts';

describe('resumableStream build-time validation', () => {
  it('builds when the stream is top-level', () => {
    const base = define({
      env: t<Record<string, unknown>>(),
      capabilities: [resumableStream()],
    });
    const handle = base.resumableStream('feed', {
      input: v.object({}),
      chunk: t<{ idx: number }>(),
      async *run() {
        yield { idx: 1 };
      },
    });
    expect(() => base.assemble({ handlers: [handle] })).not.toThrow();
  });

  it('builds when declared inside a channel', () => {
    const base = define({
      env: t<Record<string, unknown>>(),
      capabilities: [channels(), resumableStream()],
    });
    const rooms = base.channel('rooms');
    const handle = rooms.resumableStream('feed', {
      input: v.object({}),
      chunk: t<{ idx: number }>(),
      async *run() {
        yield { idx: 1 };
      },
    });
    expect(() => base.assemble({ handlers: [handle] })).not.toThrow();
  });

  // FLAGGED: the new API has no "declaration without a handler" state — a
  // base.resumableStream(...) call always carries its generator, so the missing-
  // generator path in compile.ts is unreachable through define()/assemble(). The
  // assertion is preserved by driving compileResumableStreamDef directly with an
  // empty handler map, the same path the capability builder feeds.
  it('throws when a resumableStream handler is not assembled', () => {
    const def = resumableStreamDef('feed', {
      payload: v.object({}),
    });
    expect(() => compileResumableStreamDef(def, new Map())).toThrow(
      /No handler assembled for resumableStream/,
    );
  });

  it('throws at build when keep-running is used on a non-broadcast resumableStream', () => {
    const base = define({
      env: t<Record<string, unknown>>(),
      capabilities: [resumableStream()],
    });
    expect(() =>
      base.resumableStream('feed', {
        input: v.object({}),
        chunk: t<{ idx: number }>(),
        onDisconnect: 'keep-running',
        async *run() {
          yield { idx: 1 };
        },
      }),
    ).toThrow(/keep-running.*broadcast/);
  });

  it('allows keep-running on a broadcast resumableStream', () => {
    const base = define({
      env: t<Record<string, unknown>>(),
      capabilities: [resumableStream()],
    });
    const handle = base.resumableStream('feed', {
      input: v.object({}),
      chunk: t<{ idx: number }>(),
      broadcast: true,
      onDisconnect: 'keep-running',
      async *run() {
        yield { idx: 1 };
      },
    });
    expect(() => base.assemble({ handlers: [handle] })).not.toThrow();
  });
});
