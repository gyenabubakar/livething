import { t } from '~/_api/definitions.ts';
import { server } from '~/_define/server.ts';
import { compileServerDefinition } from '~/_engine/compile/compile.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { tags } from './capability.ts';
import type { TagGroupsPrimitive } from './tags.ts';

function tagGroupsPrimitive(
  primitives: readonly { __livething: string }[],
  kind: 'ephemeral' | 'persistent',
): TagGroupsPrimitive {
  const found = primitives.find(
    (p) => p.__livething === 'tag-groups' && (p as { kind?: string }).kind === kind,
  );
  if (!found) throw new Error(`no ${kind} tag-groups primitive`);

  return found as unknown as TagGroupsPrimitive;
}

describe('tags() capability', () => {
  it('registers an ephemeral group with its name and validator', () => {
    const base = server({
      capabilities: [
        tags((ephemeral) => [
          ephemeral('role', t<string>()),
          ephemeral('color', v.picklist(['red', 'blue', 'green'])),
        ]),
      ],
    });
    const definition = base.assemble({ handlers: [] });
    const primitive = tagGroupsPrimitive(definition.primitives, 'ephemeral');
    expect(primitive.groups.map((g) => g.name)).toEqual(['role', 'color']);
    expect(primitive.groups.find((g) => g.name === 'role')?.schema).toBeUndefined();

    expect(primitive.groups.find((g) => g.name === 'color')?.schema).toBeDefined();
  });

  it('boots through the engine and registers the declared groups', () => {
    const base = server({
      capabilities: [tags((ephemeral) => [ephemeral('role', t<string>())])],
    });
    expect(() => compileServerDefinition(base.assemble({ handlers: [] }))).not.toThrow();
  });

  it('emits no ephemeral primitive when only persistent groups are declared', () => {
    const base = server({
      capabilities: [tags((_ephemeral, persistent) => [persistent('favorite', t<string>())])],
    });
    const { primitives } = base.assemble({ handlers: [] });
    expect(primitives.some((p) => p.__livething === 'tag-groups')).toBe(true);
    expect(() => tagGroupsPrimitive(primitives, 'ephemeral')).toThrow(/no ephemeral/);
    expect(tagGroupsPrimitive(primitives, 'persistent').groups.map((g) => g.name)).toEqual([
      'favorite',
    ]);
  });

  it('seeds initial ephemeral tags from the authenticate sugar', async () => {
    const base = server({
      authenticate() {
        return { userId: 'alice', tags: { ephemeral: { role: 'admin' } } };
      },
      capabilities: [tags((ephemeral) => [ephemeral('role', t<string>())])],
    });
    const authPrimitive = base
      .assemble({ handlers: [] })
      .primitives.find((p) => p.__livething === 'onAuthenticate') as unknown as {
      handler(request: Request, helpers: unknown): Promise<{ tags?: unknown }>;
    };
    const result = await authPrimitive.handler(new Request('http://x'), {});
    expect(result.tags).toEqual([
      { __livething: 'tag-ref', kind: 'ephemeral', group: 'role', key: 'admin' },
    ]);
  });

  it('omits tags from the authenticate result when none are seeded', async () => {
    const base = server({
      authenticate() {
        return { userId: 'alice' };
      },
      capabilities: [tags((ephemeral) => [ephemeral('role', t<string>())])],
    });
    const authPrimitive = base
      .assemble({ handlers: [] })
      .primitives.find((p) => p.__livething === 'onAuthenticate') as unknown as {
      handler(request: Request, helpers: unknown): Promise<{ tags?: unknown }>;
    };
    const result = await authPrimitive.handler(new Request('http://x'), {});
    expect(result.tags).toBeUndefined();
  });

  it('allows persistent groups', () => {
    const base = server({
      capabilities: [tags((_ephemeral, persistent) => [persistent('favorite', t<string>())])],
    });
    expect(() => base.assemble({ handlers: [] })).not.toThrow();
  });

  it('throws when the same group name is declared twice in one kind', () => {
    expect(() =>
      server({
        capabilities: [tags((ephemeral) => [ephemeral('role'), ephemeral('role')])],
      }),
    ).toThrow(/'role' declared twice/);
  });

  it('throws when a group name contains ::', () => {
    expect(() =>
      server({ capabilities: [tags((ephemeral) => [ephemeral('room::guests')])] }),
    ).toThrow(/name 'room::guests' contains '::'/);
    expect(() =>
      server({ capabilities: [tags((_ephemeral, persistent) => [persistent('seat::a')])] }),
    ).toThrow(/name 'seat::a' contains '::'/);
  });
});
