import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('@livething/server-node package', () => {
  it('ships ws type declarations for its public APIs', async () => {
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    const manifest = JSON.parse(await readFile(path, 'utf8')) as {
      dependencies: Record<string, string>;
    };

    expect(manifest.dependencies['@types/ws']).toBeDefined();
  });
});
