// Written by scripts/package-sizes.mjs, which the website's dev, build and generate scripts run.
import sizes from '~/package-sizes.json'

/** The size in bytes at a dotted path such as `client.minimal`. */
export function packageSize(id: string): number {
  const value = id.split('.').reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | undefined)?.[key],
    sizes,
  )
  if (typeof value !== 'number') throw new Error(`No package size is named "${id}"`)

  return value
}

/** Bytes as KB (1 KB = 1024 bytes), with fewer decimals as the number grows. */
export function formatPackageSize(bytes: number): string {
  const kb = bytes / 1024
  return `${kb.toFixed(kb < 10 ? 2 : kb < 100 ? 1 : 0)} KB`
}
