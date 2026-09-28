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

  it('publishes separate H3 v1 and v2 entry points with compatible peers', async () => {
    const path = fileURLToPath(new URL('../package.json', import.meta.url));
    const manifest = JSON.parse(await readFile(path, 'utf8')) as {
      exports: Record<string, { types: string; import: string }>;
      peerDependencies: Record<string, string>;
    };

    expect(manifest.exports['./h3']).toEqual({
      types: './dist/src/frameworks/h3/index.d.ts',
      import: './dist/h3.js',
    });
    expect(manifest.exports['./h3/v1']).toEqual({
      types: './dist/src/frameworks/h3/v1/index.d.ts',
      import: './dist/h3-v1.js',
    });
    expect(manifest.peerDependencies.h3).toBe('^1.15.11 || ^2.0.1-rc.31');
    expect(manifest.peerDependencies.crossws).toBe('^0.3.5 || ^0.4.12');
  });
});
