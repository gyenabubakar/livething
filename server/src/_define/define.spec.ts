import { t } from '~/_api/definitions.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { emits } from '~/emits/emits.ts';
import { errors } from '~/errors/capability.ts';
import { error } from '~/errors/errors.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { define } from './define.ts';

interface Env {
  SECRET: string;
}

const NotFound = error('not-found', v.object({ id: v.string() }));

function makeBase() {
  return define({
    env: t<Env>(),
    upgrade(request) {
      const username = new URL(request.url).searchParams.get('username') ?? 'anon';
      return { identity: username, meta: { username } };
    },
    capabilities: [emits({ welcome: t<{ username: string }>() }), errors([NotFound])],
  });
}

describe('define() send/receive core', () => {
  it('assembles handlers, capabilities, and the upgrade hook into a bootable server', () => {
    const base = makeBase();

    const handlePing = base.on('echo', {
      input: v.object({ text: v.string() }),
      run(ctx, input) {
        ctx.send('welcome', { username: input.text });
      },
    });

    base.connect((ctx) => {
      ctx.send('welcome', { username: ctx.meta.username });
    });

    const handler = base.assemble(handlePing);
    const compiled = compileHandlerDefinition(handler);

    expect(compiled.incoming.has('echo')).toBe(true);
    expect(compiled.outgoing.has('welcome')).toBe(true);
    expect(handler.primitives.some((p) => p.__wskit === 'onUpgrade')).toBe(true);
    expect(handler.primitives.some((p) => p.__wskit === 'onConnect')).toBe(true);
    expect(handler.primitives.some((p) => p.__wskit === 'errors')).toBe(true);
  });

  it('accepts a handler with no input schema, typing the payload as unknown', () => {
    const base = makeBase();
    const handleEcho = base.on('echo-anything', {
      run(ctx, input) {
        ctx.send('welcome', { username: String(input) });
      },
    });
    const compiled = compileHandlerDefinition(base.assemble(handleEcho));
    expect(compiled.incoming.has('echo-anything')).toBe(true);
  });

  it('registers a single intercept', () => {
    const base = makeBase();
    base.intercept((_ctx, frame) => {
      if (frame.event === 'blocked') throw new Error('blocked');
    });
    const compiled = compileHandlerDefinition(base.assemble());
    expect(compiled.intercepts).toHaveLength(1);
  });

  it('merges multiple emits capabilities into the outgoing surface', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [
        emits({ welcome: t<{ username: string }>() }),
        emits({ goodbye: t<{ username: string }>() }),
      ],
    });
    const compiled = compileHandlerDefinition(base.assemble());
    expect(compiled.outgoing.has('welcome')).toBe(true);
    expect(compiled.outgoing.has('goodbye')).toBe(true);
  });

  it('wires hibernation into a primitive and the feature set when enabled', () => {
    const base = define({ env: t<Env>(), hibernation: { enabled: true } });
    const handler = base.assemble();
    expect(handler.primitives.some((p) => p.__wskit === 'hibernation')).toBe(true);
    expect(handler.__features?.has('hibernation')).toBe(true);
  });

  it('omits hibernation when not enabled', () => {
    const base = define({ env: t<Env>() });
    const handler = base.assemble();
    expect(handler.primitives.some((p) => p.__wskit === 'hibernation')).toBe(false);
    expect(handler.__features?.has('hibernation')).toBe(false);
  });

  it.each(['init', 'connect', 'disconnect', 'error', 'validationError', 'shutdown'] as const)(
    'throws when the %s lifecycle hook is registered twice',
    (hook) => {
      const base = makeBase();
      (base[hook] as (handler: () => void) => void)(() => {});
      expect(() => (base[hook] as (handler: () => void) => void)(() => {})).toThrow(
        new RegExp(`Duplicate ${hook} hook`),
      );
    },
  );

  it('throws when a second intercept is registered', () => {
    const base = makeBase();
    base.intercept(() => {});
    expect(() => base.intercept(() => {})).toThrow(/Duplicate intercept hook/);
  });

  it('throws when the same event is bound by two handlers passed to assemble', () => {
    const base = makeBase();
    const first = base.on('echo', { input: v.object({ text: v.string() }), run() {} });
    const second = base.on('echo', { input: v.object({ text: v.string() }), run() {} });
    expect(() => base.assemble(first, second)).toThrow(/Duplicate incoming handler for 'echo'/);
  });

  it('throws when a capability is passed to assemble instead of being listed', () => {
    const base = makeBase();
    const cap = emits({ extra: t<{ ok: boolean }>() });
    expect(() => base.assemble(cap as never)).toThrow(/capability was passed to assemble/);
  });
});
