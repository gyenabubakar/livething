// Compiles every TypeScript example in website/content against the real packages, and checks that
// an event name has one payload shape across the docs.
//
// An example of up to SHORT_LINES lines may use names from fixtures/ (`ctx`, `socket`, `base`...)
// without declaring them. A longer one must bring its own imports and setup. An app helper from
// fixtures/helpers.ts may be used in any example.
//
// Tabs of one ::code-group are one small project: a tab can import another by its title.
// `<!-- docs-check: skip -->` on the line before a fence leaves that example out.
//
// Usage: node website/scripts/docs-typecheck/check.mjs [path prefix inside website/content]
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

const repo = resolve(new URL('../../..', import.meta.url).pathname);
const require = createRequire(join(repo, 'package.json'));
const ts = require('typescript');
const content = join(repo, 'website/content');
const fixtures = join(repo, 'website/scripts/docs-typecheck/fixtures');
const HUDDLE_PAGE = '7.reference/11.huddle.md';
const SHORT_LINES = 8;
const filter = process.argv[2] ?? '';

const PACKAGES = {
  '@livething/core': 'core',
  '@livething/client': 'client',
  '@livething/server': 'server',
  '@livething/server-node': 'server-adapters/node',
  '@livething/server-cloudflare': 'server-adapters/cloudflare',
};
const NAME_CODES = new Set([2304, 2552, 2503, 18004, 2580, 2591, 2582, 2583, 2584]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.md') ? [path] : [];
  });
}

/** Every checked fence, with the code-group it belongs to. */
function readExamples() {
  const examples = [];
  for (const file of walk(content)) {
    const page = relative(content, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    let open = null;
    let group = null;
    lines.forEach((line, i) => {
      if (open) {
        if (line.trim() === '```') {
          examples.push({ ...open, code: open.body.join('\n'), lineCount: open.body.length });
          open = null;
        } else open.body.push(line.slice(open.indent));
        return;
      }
      if (/^\s*::code-group/.test(line)) group = `${page}:${i + 1}`;
      else if (/^\s*::\s*$/.test(line)) group = null;
      const match = line.match(/^(\s*)```(ts|typescript)(?=\s|$)(?:\s+\[(.+?)\])?/);
      if (!match) return;
      open = {
        page,
        line: i + 1,
        indent: match[1].length,
        title: match[3] ?? '',
        group,
        // Prettier puts a blank line between the comment and the fence.
        skip:
          /docs-check: skip/.test(lines[i - 1] ?? '') ||
          /docs-check: skip/.test(lines[i - 2] ?? ''),
        body: [],
      };
    });
  }
  return examples.filter((e) => !e.skip);
}

function tabPath(title, index) {
  const cleaned = title.replace(/:\s*/g, '/').replace(/\s+/g, '-');
  const path = /\.(ts|tsx|mts|cts)$/.test(cleaned) ? cleaned : `example-${index}.ts`;
  return path.replace(/^\/+/, '').replace(/\.\.\//g, '');
}

function exportedNames(path) {
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true);
  const names = [];
  for (const s of sf.statements) {
    const exported = s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(s) && exported) {
      for (const d of s.declarationList.declarations) names.push(d.name.getText());
    } else if (exported && s.name) names.push(s.name.text);
    else if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) {
      for (const el of s.exportClause.elements) names.push(el.name.text);
    }
  }
  return names;
}

const examples = readExamples();
const workDir = mkdtempSync(join(tmpdir(), 'livething-docs-check-'));
const prelude = new Set(exportedNames(join(fixtures, 'prelude.ts')));
const helpers = new Set(exportedNames(join(fixtures, 'helpers.ts')));
const huddleExample = examples.find(
  (e) => e.page === HUDDLE_PAGE && e.title.endsWith('huddle-definition.ts'),
);
const huddlePath = join(workDir, 'huddle-definition.ts');
writeFileSync(huddlePath, huddleExample.code);
const baseExample = examples.find(
  (e) => e.page === HUDDLE_PAGE && e.title.endsWith('server/base.ts'),
);
const basePath = join(workDir, 'base.ts');
writeFileSync(basePath, baseExample.code);
const clientExample = examples.find((e) => e.page === HUDDLE_PAGE && e.title.endsWith('socket.ts'));
const clientSocketPath = join(workDir, 'client-socket.ts');
writeFileSync(clientSocketPath, clientExample.code);

const shim = join(workDir, 'shims.d.ts');
writeFileSync(
  shim,
  "declare module '*';\ndeclare const process: any;\ndeclare const Buffer: any;\ninterface ImportMeta { env: Record<string, any> }\n",
);

function exportTarget(specifier) {
  const name = Object.keys(PACKAGES).find((p) => specifier === p || specifier.startsWith(`${p}/`));
  if (!name) return null;
  const dir = join(repo, PACKAGES[name]);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const sub = `.${specifier.slice(name.length)}`;
  const entry = pkg.exports?.[sub];
  const types = typeof entry === 'string' ? entry : (entry?.types ?? entry?.import?.types);
  return types ? join(dir, types) : undefined;
}

const unknownModules = [];
function resolveModule(specifier, containing) {
  if (!containing.startsWith(workDir) && !containing.startsWith(fixtures)) {
    return ts.resolveModuleName(specifier, containing, options, ts.sys).resolvedModule
      ?.resolvedFileName;
  }
  if (specifier.startsWith('/')) return specifier;
  if (specifier === 'valibot') {
    return ts.resolveModuleName(specifier, join(repo, 'server/src/index.ts'), options, ts.sys)
      .resolvedModule?.resolvedFileName;
  }
  const target = exportTarget(specifier);
  if (target) return target;
  if (target === undefined) {
    if (containing.startsWith(workDir)) unknownModules.push({ containing, specifier });
    return undefined;
  }
  const name = basename(specifier).replace(/\.(js|mjs|ts|mts)$/, '');
  if (specifier.startsWith('@monorepo/') || specifier.startsWith('.')) {
    if (specifier.startsWith('.')) {
      const local = resolve(dirname(containing), specifier).replace(/\.(js|mjs|ts|mts)$/, '');
      if (existsSync(`${local}.ts`) && !local.startsWith(fixtures)) return `${local}.ts`;
      if (existsSync(`${local}.ts`)) return `${local}.ts`;
    }
    if (name === 'base') return basePath;
    if (name === 'huddle-definition' || name === 'huddle' || name === 'socket-types')
      return huddlePath;
    if (name === 'socket') return clientSocketPath;
    const fixture = join(fixtures, `${name}.ts`);
    if (existsSync(fixture)) return fixture;
    if (containing.startsWith(workDir)) unknownModules.push({ containing, specifier });
  }
  return undefined;
}

const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  jsx: ts.JsxEmit.Preserve,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  types: [],
};

function compile(files) {
  const host = ts.createCompilerHost(options);
  host.resolveModuleNameLiterals = (literals, containing) =>
    literals.map((literal) => {
      const resolvedFileName = resolveModule(literal.text, containing);
      if (resolvedFileName)
        return {
          resolvedModule: {
            resolvedFileName,
            extension:
              extname(resolvedFileName) === '.ts' && resolvedFileName.endsWith('.d.ts')
                ? '.d.ts'
                : extname(resolvedFileName),
          },
        };
      return { resolvedModule: undefined };
    });
  return ts.createProgram([...files, shim], options, host);
}

function writeProjects(withPrelude) {
  const dir = join(workDir, withPrelude ? 'with-prelude' : 'alone');
  rmSync(dir, { recursive: true, force: true });
  const byPath = new Map();
  examples.forEach((example, index) => {
    if (filter && !example.page.startsWith(filter)) return;
    if (example.page === HUDDLE_PAGE) return;
    const project = example.group ?? `${example.page}:${example.line}`;
    const projectDir = join(dir, project.replace(/[^\w.-]+/g, '_'));
    const path = join(projectDir, tabPath(example.title, index));
    mkdirSync(dirname(path), { recursive: true });
    const addition = withPrelude?.get(`${example.page}:${example.line}`) ?? '';
    writeFileSync(path, `${example.code}\nexport {};\n${addition}\n`);
    byPath.set(path, example);
  });
  return byPath;
}

const report = [];
function add(example, line, message) {
  report.push(`${example.page}:${example.line + 1 + line}  ${message}`);
}

// Pass 1: what does each example leave undeclared?
const alone = writeProjects(null);
const first = compile([...alone.keys()]);
const additions = new Map();
for (const [path, example] of alone) {
  const sf = first.getSourceFile(path);
  for (const d of first.getSyntacticDiagnostics(sf)) {
    add(
      example,
      sf.getLineAndCharacterOfPosition(d.start).line,
      `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
    );
  }
  const free = new Set();
  for (const d of first.getSemanticDiagnostics(sf)) {
    if (!NAME_CODES.has(d.code)) continue;
    const name = ts.flattenDiagnosticMessageText(d.messageText, ' ').match(/'([^']+)'/)?.[1];
    if (name) free.add(name);
  }
  const imports = [];
  const short = example.lineCount <= SHORT_LINES;
  for (const name of free) {
    if (name === 'v' && short) imports.push("import * as v from 'valibot';");
    else if (helpers.has(name))
      imports.push(`import { ${name} } from '${join(fixtures, 'helpers.ts')}';`);
    else if (prelude.has(name) && short)
      imports.push(`import { ${name} } from '${join(fixtures, 'prelude.ts')}';`);
    else if (prelude.has(name) || name === 'v')
      add(example, 0, `long example (${example.lineCount} lines) must import or declare '${name}'`);
    else
      add(
        example,
        0,
        `'${name}' is not defined: import it, declare it, or add it to fixtures/helpers.ts`,
      );
  }
  additions.set(`${example.page}:${example.line}`, imports.join('\n'));
}

// Pass 2: the real type errors, with the fixture names filled in.
const filled = writeProjects(additions);
unknownModules.length = 0;
const second = compile([...filled.keys(), basePath, huddlePath, clientSocketPath]);
for (const [path, example] of filled) {
  const sf = second.getSourceFile(path);
  const ownLines = example.code.split('\n').length;
  for (const d of second.getSemanticDiagnostics(sf)) {
    if (NAME_CODES.has(d.code) || d.start === undefined) continue;
    // A callback passed to a framework the repo doesn't install has no type to infer from.
    if (d.code === 7006 && /from '(?!@livething|valibot|\.|\/)/.test(example.code)) continue;
    const line = sf.getLineAndCharacterOfPosition(d.start).line;
    if (line >= ownLines) continue;
    add(
      example,
      line,
      `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 400)}`,
    );
  }
}
for (const { containing, specifier } of unknownModules) {
  const example = filled.get(containing);
  if (example)
    add(
      example,
      0,
      `cannot resolve '${specifier}': add a tab with that file, or add it to fixtures/`,
    );
}
for (const path of [basePath, huddlePath, clientSocketPath]) {
  const sf = second.getSourceFile(path);
  for (const d of second.getSemanticDiagnostics(sf)) {
    report.push(
      `${HUDDLE_PAGE} (${basename(path)}) L${sf.getLineAndCharacterOfPosition(d.start).line + 1}  TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 400)}`,
    );
  }
}

// One event name, one payload shape, across every example.
const VERBS = new Set([
  'on',
  'send',
  'broadcast',
  'request',
  'stream',
  'recordedStream',
  'schedule',
  'broadcastTo',
]);
const shapes = new Map();
function record(event, keys, where) {
  if (keys === null || keys.includes('...')) return;
  if (!shapes.has(event)) shapes.set(event, new Map());
  const seen = shapes.get(event);
  const key = keys.join(',');
  if (!seen.has(key)) seen.set(key, []);
  seen.get(key).push(where);
}
function objectKeys(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  return node.properties
    .map((p) => (ts.isSpreadAssignment(p) ? '...' : p.name.getText().replace(/['"]/g, '')))
    .sort();
}
function typeKeys(node) {
  if (!node || !ts.isTypeLiteralNode(node)) return null;
  return node.members.map((m) => m.name?.getText().replace(/['"]/g, '') ?? '...').sort();
}
for (const example of examples) {
  const sf = ts.createSourceFile('x.ts', example.code, ts.ScriptTarget.ES2022, true);
  const where = `${example.page}:${example.line}`;
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      if (
        callee === 'emits' &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        for (const prop of node.arguments[0].properties) {
          if (ts.isPropertyAssignment(prop) && ts.isCallExpression(prop.initializer)) {
            record(
              prop.name.getText().replace(/['"]/g, ''),
              typeKeys(prop.initializer.typeArguments?.[0]),
              where,
            );
          }
        }
      }
      if (ts.isPropertyAccessExpression(node.expression) && VERBS.has(node.expression.name.text)) {
        const [first, second] = node.arguments;
        if (first && ts.isStringLiteralLike(first) && second) {
          const keys = objectKeys(second);
          if (keys?.includes('run')) {
            const input = second.properties.find((p) => p.name?.getText() === 'input');
            const schema = input && ts.isPropertyAssignment(input) ? input.initializer : null;
            if (schema && ts.isCallExpression(schema) && schema.expression.getText() === 'v.object')
              record(first.text, objectKeys(schema.arguments[0]), where);
          } else if (node.expression.name.text !== 'on') record(first.text, keys, where);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}
for (const [event, seen] of [...shapes].sort()) {
  if (seen.size < 2) continue;
  const inScope = [...seen.values()].flat().some((w) => w.startsWith(filter));
  if (!inScope) continue;
  const parts = [...seen].map(([keys, where]) => `{${keys}} x${where.length} (${where[0]})`);
  report.push(`event '${event}' has ${seen.size} shapes: ${parts.join('; ')}`);
}

rmSync(workDir, { recursive: true, force: true });
const unique = [...new Set(report)];
console.log(unique.join('\n'));
console.log(`\n${examples.length} examples, ${unique.length} problems`);
process.exit(unique.length ? 1 : 0);
