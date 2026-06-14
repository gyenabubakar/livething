import { t } from '~/_api/definitions.ts';
import { define } from '~/_define/define.ts';
import { compileHandlerDefinition } from '~/_engine/compile/compile.ts';
import { persistence } from '~/persistence/capability.ts';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { tags } from './capability.ts';
import type { TagGroupsPrimitive } from './tags.ts';

interface Env {
  SECRET: string;
}

function tagGroupsPrimitive(
  primitives: readonly { __wskit: string }[],
  kind: 'ephemeral' | 'persistent',
): TagGroupsPrimitive {
  const found = primitives.find(
    (p) => p.__wskit === 'tag-groups' && (p as { kind?: string }).kind === kind,
  );
  if (!found) throw new Error(`no ${kind} tag-groups primitive`);
  return found as unknown as TagGroupsPrimitive;
}

describe('tags() capability', () => {
  it('registers an ephemeral group with its name and validator', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [
        tags((ephemeral) => [
          ephemeral('role', t<string>()),
          ephemeral('color', v.picklist(['red', 'blue', 'green'])),
        ]),
      ],
    });
    const handler = base.assemble();
    const primitive = tagGroupsPrimitive(handler.primitives, 'ephemeral');
    expect(primitive.groups.map((g) => g.name)).toEqual(['role', 'color']);
    expect(primitive.groups.find((g) => g.name === 'role')?.schema).toBeUndefined();
    expect(primitive.groups.find((g) => g.name === 'color')?.schema).toBeDefined();
  });

  it('boots through the engine and registers the declared groups', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [tags((ephemeral) => [ephemeral('role', t<string>())])],
    });
    expect(() => compileHandlerDefinition(base.assemble())).not.toThrow();
  });

  it('emits no ephemeral primitive when only persistent groups are declared', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [
        tags((_ephemeral, persistent) => [persistent('favorite', t<string>())]),
        persistence(),
      ],
    });
    const { primitives } = base.assemble();
    expect(primitives.some((p) => p.__wskit === 'tag-groups')).toBe(true);
    expect(() => tagGroupsPrimitive(primitives, 'ephemeral')).toThrow(/no ephemeral/);
    expect(tagGroupsPrimitive(primitives, 'persistent').groups.map((g) => g.name)).toEqual([
      'favorite',
    ]);
  });

  it('seeds initial ephemeral tags from the upgrade sugar', async () => {
    const base = define({
      env: t<Env>(),
      upgrade() {
        return { identity: 'alice', tags: { ephemeral: { role: 'admin' } } };
      },
      capabilities: [tags((ephemeral) => [ephemeral('role', t<string>())])],
    });
    const upgradePrimitive = base
      .assemble()
      .primitives.find((p) => p.__wskit === 'onUpgrade') as unknown as {
      handler(request: Request, helpers: unknown): Promise<{ tags?: unknown }>;
    };
    const result = await upgradePrimitive.handler(new Request('http://x'), {});
    expect(result.tags).toEqual([
      { __wskit: 'tag-ref', kind: 'ephemeral', group: 'role', key: 'admin' },
    ]);
  });

  it('omits tags from the upgrade result when none are seeded', async () => {
    const base = define({
      env: t<Env>(),
      upgrade() {
        return { identity: 'alice' };
      },
      capabilities: [tags((ephemeral) => [ephemeral('role', t<string>())])],
    });
    const upgradePrimitive = base
      .assemble()
      .primitives.find((p) => p.__wskit === 'onUpgrade') as unknown as {
      handler(request: Request, helpers: unknown): Promise<{ tags?: unknown }>;
    };
    const result = await upgradePrimitive.handler(new Request('http://x'), {});
    expect(result.tags).toBeUndefined();
  });

  it('throws when persistent groups are declared without the persistence() capability', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [tags((_ephemeral, persistent) => [persistent('favorite', t<string>())])],
    });
    expect(() => base.assemble()).toThrow(/persistent tag groups require the persistence\(\)/);
  });

  it('allows persistent groups when persistence() is also listed', () => {
    const base = define({
      env: t<Env>(),
      capabilities: [
        tags((_ephemeral, persistent) => [persistent('favorite', t<string>())]),
        persistence(),
      ],
    });
    expect(() => base.assemble()).not.toThrow();
  });

  it('throws when the same group name is declared twice in one kind', () => {
    expect(() =>
      define({
        env: t<Env>(),
        capabilities: [tags((ephemeral) => [ephemeral('role'), ephemeral('role')])],
      }),
    ).toThrow(/'role' declared twice/);
  });
});
