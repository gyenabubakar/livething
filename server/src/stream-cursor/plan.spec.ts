/* oxlint-disable @typescript-eslint/no-explicit-any */
import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { channels } from '~/channel/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { cursorStream } from './capability.ts';
import { compileCursorStreamDef } from './compile.ts';
import { cursorStream as cursorStreamDef } from './definition.ts';

describe('cursorStream build-time validation', () => {
  it('builds when the stream is top-level', () => {
    const base = server({
      capabilities: [cursorStream()],
    });
    const handle = base.cursorStream('feed', {
      input: v.object({}),
      chunk: t<{ idx: number }>(),
      async *run() {
        yield { idx: 1 };
      },
    });
    expect(() => base.assemble({ handlers: [handle] })).not.toThrow();
  });

  it('builds when declared inside a channel', () => {
    const base = server({
      capabilities: [channels(), cursorStream()],
    });
    const rooms = base.channel('rooms');
    const handle = rooms.cursorStream('feed', {
      input: v.object({}),
      chunk: t<{ idx: number }>(),
      async *run() {
        yield { idx: 1 };
      },
    });
    expect(() => base.assemble({ handlers: [handle] })).not.toThrow();
  });

  // FLAGGED: the new API has no "declaration without a handler" state — a
  // base.cursorStream(...) call always carries its generator, so the missing-
  // generator path in compile.ts is unreachable through server()/assemble(). The
  // assertion is preserved by driving compileCursorStreamDef directly with an
  // empty handler map, the same path the capability builder feeds.
  it('throws when a cursorStream handler is not assembled', () => {
    const def = cursorStreamDef('feed', {
      payload: v.object({}),
    });
    expect(() => compileCursorStreamDef(def, new Map())).toThrow(
      /No handler assembled for cursorStream/,
    );
  });

  it('throws at build when keep-running is used on a non-broadcast cursorStream', () => {
    const base = server({
      capabilities: [cursorStream()],
    });
    expect(() =>
      base.cursorStream('feed', {
        input: v.object({}),
        chunk: t<{ idx: number }>(),
        onDisconnect: 'keep-running',
        async *run() {
          yield { idx: 1 };
        },
      }),
    ).toThrow(/keep-running.*broadcast/);
  });

  it('allows keep-running on a broadcast cursorStream', () => {
    const base = server({
      capabilities: [cursorStream()],
    });
    const handle = base.cursorStream('feed', {
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
