import { server } from '~/_define/server.ts';
import { compileServerDefinition } from '~/_engine/compile/compile.ts';
import { emits, t } from '~/index.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

describe('event names', () => {
  it('accepts ping and pong, because keepalive frames are bare text, not events', () => {
    const base = server({ capabilities: [emits({ pong: t<{ at: number }>() })] });
    const handlePing = base.on('ping', {
      input: v.object({ at: v.number() }),
      run(ctx, input) {
        ctx.send('pong', input);
      },
    });

    expect(() => compileServerDefinition(base.assemble({ handlers: [handlePing] }))).not.toThrow();
  });

  it('still rejects a name in the reserved __ namespace', () => {
    const base = server({});
    expect(() => base.on('__subscribe__', { run() {} })).toThrow();
  });
});
