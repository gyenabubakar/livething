// Codemod: rewrite `X.assemble(a, b, c)` → `X.assemble({ handlers: [a, b, c] })`.
//
// Part of the assemble({ handlers, api }) migration. Run it scoped to your own
// slice of files so parallel agents never touch the same file:
//
//   node scripts/codemod-assemble.mjs --write server/src/channel        # a dir (recurses *.ts)
//   node scripts/codemod-assemble.mjs --write path/to/one.spec.ts       # a single file
//   node scripts/codemod-assemble.mjs server/src/tags                   # dry run (no --write)
//
// Only `.ts` files. Markdown snippets are migrated by hand (prose context).
// Already-config-form calls (`assemble({ handlers: ... })`) are left untouched.
// The pre-commit `format` step cleans up any indentation the rewrite introduces.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
const write = args.includes('--write');
const roots = args.filter((a) => a !== '--write');
if (roots.length === 0) {
  console.error('usage: node scripts/codemod-assemble.mjs [--write] <file-or-dir>...');
  process.exit(1);
}

/** Collect every `.ts` file under the given paths. */
function collect(paths) {
  const out = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) {
        if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
        out.push(...collect([join(p, entry)]));
      }
    } else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** Is this call already the config form `assemble({ handlers: ... })`? */
function isConfigForm(call) {
  if (call.arguments.length !== 1) return false;
  const arg = call.arguments[0];
  return (
    ts.isObjectLiteralExpression(arg) &&
    arg.properties.some(
      (prop) =>
        (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
        prop.name &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === 'handlers',
    )
  );
}

let filesChanged = 0;
let callsChanged = 0;

for (const file of collect(roots)) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  /** @type {{ start: number, end: number, inner: string }[]} */
  const edits = [];
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'assemble' &&
      !isConfigForm(node)
    ) {
      const call = node;
      const openStart = call.arguments.pos; // right after `(`
      const openEnd = call.arguments.end; // right before `)`
      const inner =
        call.arguments.length === 0
          ? ''
          : src.slice(call.arguments[0].getStart(sf), call.arguments.at(-1).getEnd());
      edits.push({ start: openStart, end: openEnd, inner });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  if (edits.length === 0) continue;

  // Apply right-to-left so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let next = src;
  for (const e of edits) {
    next = next.slice(0, e.start) + `{ handlers: [${e.inner}] }` + next.slice(e.end);
  }

  filesChanged += 1;
  callsChanged += edits.length;
  if (write) {
    writeFileSync(file, next);
    console.log(`  rewrote ${edits.length}  ${file}`);
  } else {
    console.log(`  would rewrite ${edits.length}  ${file}`);
  }
}

console.log(
  `\n${write ? 'rewrote' : 'would rewrite'} ${callsChanged} call(s) across ${filesChanged} file(s)`,
);
