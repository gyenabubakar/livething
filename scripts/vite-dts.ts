import path from 'node:path';

/**
 * Rewrite leftover `~/...` alias imports in emitted `.d.ts` files to relative
 * paths.
 *
 * vite-plugin-dts rewrites the alias for named imports (`import { X } from
 * '~/...'`) but leaves namespace imports (`import type * as X from '~/...'`)
 * as the raw `~/` alias. Consumers of the package have no `~` path mapping, so
 * any type re-exported through such a namespace import resolves to `any` —
 * silently turning a typed public API into `any` with no error at build time.
 *
 * Wire this into the dts plugin's `beforeWriteFile` so every emitted
 * declaration file ships resolvable relative imports instead.
 *
 * @param distRoot Absolute path the `~` alias maps to in the output (the
 *   package's `dist` directory, which mirrors `src`).
 */
export function relativizeTildeImports(distRoot: string) {
  return (filePath: string, content: string): void | { filePath: string; content: string } => {
    let rel = path.relative(path.dirname(filePath), distRoot).replaceAll('\\', '/');
    if (rel === '') rel = '.';

    const rewritten = content.replace(
      /(\bfrom\s+['"])~\/([^'"]*)(['"])/g,
      (_match: string, ...groups: string[]) => `${groups[0]}${rel}/${groups[1]}${groups[2]}`,
    );

    if (rewritten === content) return;
    return { filePath, content: rewritten };
  };
}
