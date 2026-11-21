import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
/** Where LiveThing's own packages keep their source. Tests and e2e handlers are app code. */
const SOURCES = ['server/src', 'server-adapters', 'plugins'];
const METADATA = /\bmetadata\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'\{\}'/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return /\.ts$/.test(name) && !/\.(spec|test|test-d|bench)\.ts$/.test(name) ? [path] : [];
  });
}

/** Each `CREATE TABLE` in `source`: its name and the text between its parentheses. */
function tablesIn(source: string): { name: string; body: string }[] {
  const tables: { name: string; body: string }[] = [];
  const start = /CREATE TABLE(?: IF NOT EXISTS)?\s+([\w${}.]+)\s*\(/g;
  for (let match = start.exec(source); match; match = start.exec(source)) {
    let depth = 1;
    let at = start.lastIndex;
    for (; at < source.length && depth > 0; at += 1) {
      if (source[at] === '(') depth += 1;
      else if (source[at] === ')') depth -= 1;
    }

    tables.push({ name: match[1]!, body: source.slice(start.lastIndex, at) });
  }

  return tables;
}

describe('the SQL tables LiveThing defines', () => {
  it("each has a `metadata TEXT NOT NULL DEFAULT '{}'` column, for new fields without a migration", () => {
    const tables = SOURCES.flatMap((dir) => sourceFiles(join(ROOT, dir))).flatMap((file) =>
      tablesIn(readFileSync(file, 'utf8')).map((table) => ({
        ...table,
        where: `${relative(ROOT, file)} ${table.name}`,
      })),
    );

    expect(tables.length).toBeGreaterThan(20);
    expect(
      tables.filter((table) => !METADATA.test(table.body)).map((table) => table.where),
    ).toEqual([]);
  });
});
