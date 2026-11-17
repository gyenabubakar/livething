// Compiles every TypeScript, JavaScript, TSX, Vue and Svelte example in website/content against the real
// packages, and checks that an event name has one payload shape across the docs.
//
// TSX files use the JSX types of fixtures/modules (React, or Solid on the Solid page). Vue files go through
// vue-tsc's language plugin and Svelte files through svelte2tsx, so templates are type checked too. Both are
// parsed by the framework's own compiler first. An error in a Svelte file reports the fence's first line, plus
// the generated code that failed.
//
// An example of up to SHORT_LINES lines may use names from fixtures/ (`ctx`, `socket`, `base`, app
// helpers...) without declaring them. A longer one must bring its own imports and setup.
//
// Tabs of one ::code-group are one small project: a tab can import another by its title.
// `<!-- docs-check: skip -->` on the line before a fence leaves that example out.
//
// It also runs the repo's layout lint rules on each example: blank lines, and braces around an `if` body
// that wraps. `--fix` fixes them in the pages.
//
// Usage: node website/scripts/docs-typecheck/check.mjs [--fix] [path prefix inside website/content]
import { spawnSync } from 'node:child_process';
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
import { proxyCreateProgram } from '@volar/typescript';
import { compileScript, compileTemplate, parse as parseVue } from '@vue/compiler-sfc';
import { createVueLanguagePlugin, getDefaultCompilerOptions } from '@vue/language-core';
import { compile as compileSvelte, VERSION as SVELTE_VERSION } from 'svelte/compiler';
import { svelte2tsx } from 'svelte2tsx';

const repo = resolve(new URL('../../..', import.meta.url).pathname);
const require = createRequire(join(repo, 'package.json'));
const ts = require('typescript');
const content = join(repo, 'website/content');
const fixtures = join(repo, 'website/scripts/docs-typecheck/fixtures');
const HUDDLE_PAGE = '8.reference/11.huddle.md';
const SHORT_LINES = 8;
const args = process.argv.slice(2);
const fixLayout = args.includes('--fix');
const filter = args.find((arg) => !arg.startsWith('--')) ?? '';

const PACKAGES = {
  '@livething/core': 'core',
  '@livething/client': 'client',
  '@livething/server': 'server',
  '@livething/server-node': 'server-adapters/node',
  '@livething/server-cloudflare': 'server-adapters/cloudflare',
};
const MODULE_FIXTURES = {
  react: 'react',
  'react/jsx-runtime': 'react',
  'react-native': 'react-native',
  'solid-js': 'solid-js',
  'solid-js/jsx-runtime': 'solid-js',
};
const NAME_CODES = new Set([2304, 2552, 2503, 18004, 2580, 2591, 2582, 2583, 2584]);
const UNTYPED_CALL_WITH_TYPE_ARGS = 2347;
const JS_IMPLICIT_ANY_CODES = new Set([7006, 7031, 7053]);

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
    let section = '';
    lines.forEach((line, i) => {
      if (open) {
        if (line.trim() === '```') {
          examples.push({ ...open, code: open.body.join('\n'), lineCount: open.body.length });
          open = null;
        } else open.body.push(line.slice(open.indent));
        return;
      }
      const heading = line.match(/^##\s+(.+)/);
      if (heading) section = heading[1];
      if (/^\s*::code-group/.test(line)) group = `${page}:${i + 1}`;
      else if (/^\s*::\s*$/.test(line)) group = null;
      const match = line.match(
        /^(\s*)```(ts|typescript|js|tsx|vue|svelte)(?=\s|$)(?:\s+\[(.+?)\])?/,
      );
      if (!match) return;
      open = {
        page,
        line: i + 1,
        lang: match[2],
        indent: match[1].length,
        title: match[3] ?? '',
        group,
        section,
        // Prettier puts a blank line between the comment and the fence.
        skip:
          /docs-check: skip/.test(lines[i - 1] ?? '') ||
          /docs-check: skip/.test(lines[i - 2] ?? ''),
        body: [],
      };
    });
  }
  return examples;
}

function tabPath(title, lang, index) {
  const cleaned = title.replace(/:\s*/g, '/').replace(/\s+/g, '-');
  const isFile = /\.(ts|tsx|mts|cts|js|mjs|vue|svelte)$/.test(cleaned);
  const fallback = { vue: '.vue', svelte: '.svelte', tsx: '.tsx' }[lang] ?? '.ts';
  const file = isFile ? cleaned : `example-${index}${fallback}`;
  const path = lang === 'svelte' ? `${file}.ts` : file;
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

const allExamples = readExamples();
const examples = allExamples.filter((e) => !e.skip);
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
  "declare module '*';\ndeclare module 'hono' { export const Hono: any; export type Context = any; export type Next = any; }\ndeclare const process: any;\ndeclare const Buffer: any;\ninterface ImportMeta { env: Record<string, any> }\n",
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

/**
 * One file per fence on a framework page, so `./use-store` finds the page's own `use-store.ts`. Other
 * pages show parts of a file, so their `./socket` still means Huddle's full client socket.
 */
const pageFiles = new Map();
const fileExamples = new Map();
// A Nitro page shows its `huddle-endpoint` twice: once to set it up, and once more with `http()`.
// There a file belongs to its `##` section, not to the whole page.
const NITRO_PAGES = [
  '4.runtimes/02.node-frameworks/06.nuxt.md',
  '4.runtimes/02.node-frameworks/07.solidstart.md',
];
const fileScope = (example) =>
  NITRO_PAGES.includes(example.page) ? `${example.page}#${example.section}` : example.page;
const pageFileKey = (example, name) => `${fileScope(example)}\0${name}`;
const withoutExtension = (path) => basename(path).replace(/(\.svelte)?\.\w+$/, '');

function pageFile(containing, name) {
  const example = fileExamples.get(containing);
  // Each plugins page builds its own `Polls`, so an example there imports the page's
  // own file. The Quickstart builds its own small server. The Nitro pages build their
  // endpoint with H3, not `node:http`. A name the page uses for more than one file stays
  // on the shared fixture.
  const ownsFiles =
    example?.page.startsWith('7.recipes/01.framework-hooks/') ||
    example?.page.startsWith('5.client/08.plugins/') ||
    example?.page.startsWith('1.start/06.quickstart') ||
    example?.page.startsWith('2.learn/11.identity-and-access') ||
    NITRO_PAGES.includes(example?.page);
  if (!ownsFiles) return undefined;
  const path = pageFiles.get(pageFileKey(example, name));
  return path && path !== containing ? path : undefined;
}

function huddleUiFixture(containing) {
  if (containing.endsWith('.vue')) return 'huddle-ui-vue';
  if (containing.endsWith('.svelte.ts')) return 'huddle-ui-svelte';
  return containing.includes('04.solid') ? 'huddle-ui-solid' : 'huddle-ui';
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
  if (specifier in MODULE_FIXTURES) {
    return join(fixtures, 'modules', `${MODULE_FIXTURES[specifier]}.ts`);
  }
  if (/^(vue|svelte)(\/|$)/.test(specifier)) {
    return ts.resolveModuleName(specifier, join(repo, 'website/package.json'), options, ts.sys)
      .resolvedModule?.resolvedFileName;
  }
  // Build output, such as `./build/handler.js`, does not exist until the app builds.
  if (/^\.\/(build|dist)\//.test(specifier)) return undefined;
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
      const sibling = pageFile(containing, name);
      if (sibling) return sibling;
      if (name === 'huddle-ui' && containing.startsWith(workDir)) {
        return join(fixtures, `${huddleUiFixture(containing)}.ts`);
      }
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
  allowJs: true,
  checkJs: true,
  jsx: ts.JsxEmit.Preserve,
  // Internal to TypeScript. It lets `.vue` files be root files, as vue-tsc's patched tsc does.
  allowNonTsExtensions: true,
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
  const createProgram = proxyCreateProgram(ts, ts.createProgram, (proxiedTs) => ({
    languagePlugins: [createVueLanguagePlugin(proxiedTs, options, vueOptions, (id) => id)],
  }));
  return createProgram({ rootNames: [...files, shim, ...svelteShims], options, host });
}

const vueOptions = getDefaultCompilerOptions(options.target, 'vue', true);
const websiteModules = join(repo, 'website/node_modules');
const svelteShims = [
  join(websiteModules, 'svelte2tsx/svelte-shims-v4.d.ts'),
  join(websiteModules, 'svelte/svelte-html.d.ts'),
  join(websiteModules, 'svelte/types/index.d.ts'),
];

/** Syntax errors from Vue's and Svelte's own compilers. Such a file can't go on to the type check. */
function compilerErrors(example) {
  const filename = example.title || `example.${example.lang}`;
  const errors = [];
  const attempt = (run) => {
    try {
      run();
    } catch (error) {
      const line = (error.loc?.start.line ?? error.start?.line ?? 1) - 1;
      errors.push({ line, message: error.message });
    }
  };
  if (example.lang === 'svelte') {
    attempt(() => compileSvelte(example.code, { filename, generate: false }));
  } else if (example.lang === 'vue') {
    const { descriptor, errors: parseErrors } = parseVue(example.code, { filename });
    for (const error of parseErrors) {
      errors.push({ line: (error.loc?.start.line ?? 1) - 1, message: error.message });
    }
    if (descriptor.scriptSetup || descriptor.script) {
      attempt(() => compileScript(descriptor, { id: filename }));
    }
    if (descriptor.template) {
      const { content, loc } = descriptor.template;
      const result = compileTemplate({ source: content, filename, id: filename });
      for (const error of result.errors) {
        const line = typeof error === 'string' ? 0 : (error.loc?.start.line ?? 1) - 1;
        const message = typeof error === 'string' ? error : error.message;
        errors.push({ line: loc.start.line - 1 + line, message });
      }
    }
  }
  return errors;
}

/** The file that represents a fence in the program, with the fixture imports it needs. */
function projectSource(example, addition, path) {
  if (example.lang === 'vue') {
    return example.code.replace('</script>', () => `${addition}\n</script>`);
  }
  if (example.lang === 'svelte') {
    const { code } = svelte2tsx(example.code, {
      filename: basename(path, '.ts'),
      isTsFile: true,
      mode: 'ts',
      version: SVELTE_VERSION,
    });
    // svelteShims load the same types; this program has no type roots to find a reference in.
    return `${code.replace('///<reference types="svelte" />', '')}\n${addition}\n`;
  }
  const jsxSource = example.page.includes('04.solid') ? 'solid-js' : 'react';
  // On the first line, so the line numbers still match the fence.
  const pragma = example.lang === 'tsx' ? `/** @jsxImportSource ${jsxSource} */ ` : '';
  return `${pragma}${example.code}\nexport {};\n${addition}\n`;
}

function writeProjects(withPrelude) {
  const dir = join(workDir, withPrelude ? 'with-prelude' : 'alone');
  rmSync(dir, { recursive: true, force: true });
  const byPath = new Map();
  examples.forEach((example, index) => {
    if (filter && !example.page.startsWith(filter)) return;
    if (example.page === HUDDLE_PAGE || unparsable.has(example)) return;
    const project = example.group ?? `${example.page}:${example.line}`;
    const projectDir = join(dir, project.replace(/[^\w.-]+/g, '_'));
    const path = join(projectDir, tabPath(example.title, example.lang, index));
    mkdirSync(dirname(path), { recursive: true });
    const addition = withPrelude?.get(`${example.page}:${example.line}`) ?? '';
    writeFileSync(path, projectSource(example, addition, path));
    byPath.set(path, example);
    fileExamples.set(path, example);
    const key = pageFileKey(example, withoutExtension(path));
    pageFiles.set(key, pageFiles.has(key) ? null : path);
  });
  return byPath;
}

const report = [];
function add(example, line, message) {
  report.push(`${example.page}:${example.line + 1 + line}  ${message}`);
}
/** Where a TypeScript error sits in the fence. Svelte has no line map, so it shows the generated code. */
function addDiagnostic(example, d, message) {
  const { line } = d.file.getLineAndCharacterOfPosition(d.start);
  if (example.lang !== 'svelte') return add(example, line, message);
  const generated = d.file.text.split('\n')[line].trim().slice(0, 120);
  add(example, 0, `${message} (in generated code: ${generated})`);
}

const unparsable = new Set();
for (const example of examples) {
  if (filter && !example.page.startsWith(filter)) continue;
  for (const { line, message } of compilerErrors(example)) {
    add(example, line, `${example.lang} compiler: ${message}`);
    unparsable.add(example);
  }
}

// Pass 1: what does each example leave undeclared?
pageFiles.clear();
const alone = writeProjects(null);
const first = compile([...alone.keys()]);
const additions = new Map();
for (const [path, example] of alone) {
  const sf = first.getSourceFile(path);
  // With no file, the diagnostic calls below would return those of the whole program.
  if (!sf) throw new Error(`${path} is not in the program`);
  for (const d of first.getSyntacticDiagnostics(sf)) {
    addDiagnostic(example, d, `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
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
    else if (helpers.has(name) && short)
      imports.push(`import { ${name} } from '${join(fixtures, 'helpers.ts')}';`);
    else if (prelude.has(name) && short)
      imports.push(`import { ${name} } from '${join(fixtures, 'prelude.ts')}';`);
    else if (helpers.has(name) || prelude.has(name) || name === 'v')
      add(example, 0, `long example (${example.lineCount} lines) must import or declare '${name}'`);
    else
      add(
        example,
        0,
        `'${name}' is not defined: import it, declare it, or, for an example of up to ${SHORT_LINES} lines, add it to fixtures/helpers.ts`,
      );
  }
  additions.set(`${example.page}:${example.line}`, imports.join('\n'));
}

function nodeAt(sf, position) {
  let node = sf;
  for (;;) {
    const child = ts.forEachChild(node, (c) =>
      c.getStart(sf) <= position && position < c.getEnd() ? c : undefined,
    );
    if (!child) return node;
    node = child;
  }
}

/**
 * True when a callback's parameter gets no type only because the function it is passed to comes
 * from a package the repo doesn't install (`declare module '*'` makes that function `any`).
 */
function isCallbackToUninstalledPackage(checker, sf, position) {
  let node = nodeAt(sf, position);
  while (node && !ts.isFunctionLike(node)) node = node.parent;
  let parent = node?.parent;
  while (
    parent &&
    (ts.isObjectLiteralExpression(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isParenthesizedExpression(parent))
  ) {
    parent = parent.parent;
  }
  if (!parent || !(ts.isCallExpression(parent) || ts.isNewExpression(parent))) return false;
  return Boolean(checker.getTypeAtLocation(parent.expression).flags & ts.TypeFlags.Any);
}

// Pass 2: the real type errors, with the fixture names filled in.
pageFiles.clear();
const filled = writeProjects(additions);
unknownModules.length = 0;
const second = compile([...filled.keys(), basePath, huddlePath, clientSocketPath]);
const checker = second.getTypeChecker();
for (const [path, example] of filled) {
  const sf = second.getSourceFile(path);
  const ownLines = example.code.split('\n').length;
  for (const d of second.getSemanticDiagnostics(sf)) {
    if (NAME_CODES.has(d.code) || d.start === undefined) continue;
    if (
      d.code === 7006 &&
      example.lang !== 'vue' &&
      isCallbackToUninstalledPackage(checker, sf, d.start)
    )
      continue;
    // A package the repo doesn't install is `any`, so its generic call can't take type arguments.
    if (d.code === UNTYPED_CALL_WITH_TYPE_ARGS) continue;
    // JavaScript has no way to write the type these name.
    if (/\.m?js$/.test(path) && JS_IMPLICIT_ANY_CODES.has(d.code)) continue;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    if (example.lang !== 'svelte' && line >= ownLines) continue;
    addDiagnostic(
      example,
      d,
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
const typeShapes = new Map();
function tally(map, event, shape, where) {
  if (!map.has(event)) map.set(event, new Map());
  const seen = map.get(event);
  if (!seen.has(shape)) seen.set(shape, []);
  seen.get(shape).push(where);
}
function record(event, keys, where) {
  if (keys === null || keys.includes('...')) return;
  tally(shapes, event, keys.join(','), where);
}
function normalize(text) {
  return text
    .replace(/\s+/g, '')
    .replace(/[;,]([}\]])/g, '$1')
    .replace(/;/g, ',');
}
/** Named types and schemas that one example declares at its top level. */
function declaredNames(sf) {
  const types = new Map();
  const schemas = new Map();
  for (const s of sf.statements) {
    if (ts.isTypeAliasDeclaration(s)) types.set(s.name.text, normalize(s.type.getText()));
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (d.initializer) schemas.set(d.name.getText(), normalize(d.initializer.getText()));
      }
    }
  }
  return { types, schemas };
}
function parseExample(example) {
  const isComponent = example.lang === 'vue' || example.lang === 'svelte';
  const code = isComponent
    ? (example.code.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '')
    : example.code;
  return ts.createSourceFile(
    example.lang === 'tsx' ? 'x.tsx' : 'x.ts',
    code,
    ts.ScriptTarget.ES2022,
    true,
  );
}
const huddleNames = examples
  .filter((e) => e.page === HUDDLE_PAGE)
  .map((e) => declaredNames(parseExample(e)));
function lookup(local, kind, name) {
  return (
    local[kind].get(name) ?? huddleNames.map((n) => n[kind].get(name)).find((v) => v !== undefined)
  );
}
/** `Status` and `v.picklist(['a'])`'s inferred type print the same as the union they stand for. */
function canonicalType(text, local) {
  return text
    .split('|')
    .map((part) => {
      const inferred = part.match(/^v\.InferOutput<typeof(\w+)>$/)?.[1];
      const schema = inferred && lookup(local, 'schemas', inferred);
      const picklist = schema?.match(/^v\.picklist\(\[(.*)\]\)$/)?.[1];
      if (picklist) return picklist.split(',').join('|');
      const named = lookup(local, 'types', part);
      return named && named !== text ? canonicalType(named, local) : part;
    })
    .join('|');
}
/** A named schema prints as its definition. `v.pipe` checks add rules but keep the value type. */
function canonicalSchema(text, local) {
  const named = lookup(local, 'schemas', text);
  const schema = named ?? text;
  return schema.match(/^v\.pipe\((v\.\w+\(\)),.*\)$/)?.[1] ?? schema;
}
/** A declared payload's property types, or a schema's validators, as comparable text. */
function recordTypes(event, source, entries, where) {
  if (entries.some(([name]) => name === '...')) return;
  const shape = entries
    .map(([name, value]) => `${name}: ${value}`)
    .sort()
    .join(', ');
  tally(typeShapes, `${source} '${event}'`, shape, where);
}
function objectKeys(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  return node.properties
    .map((p) => (ts.isSpreadAssignment(p) ? '...' : p.name.getText().replace(/['"]/g, '')))
    .sort();
}
function schemaEntries(node, local) {
  return node.properties.map((p) => [
    ts.isSpreadAssignment(p) ? '...' : p.name.getText().replace(/['"]/g, ''),
    ts.isPropertyAssignment(p) ? canonicalSchema(normalize(p.initializer.getText()), local) : '',
  ]);
}
function typeKeys(node) {
  if (!node || !ts.isTypeLiteralNode(node)) return null;
  return node.members.map((m) => m.name?.getText().replace(/['"]/g, '') ?? '...').sort();
}
function typeEntries(node, local) {
  return node.members.map((m) => [
    `${m.name?.getText().replace(/['"]/g, '') ?? '...'}${m.questionToken ? '?' : ''}`,
    m.type ? canonicalType(normalize(m.type.getText()), local) : '',
  ]);
}
for (const example of examples) {
  const sf = parseExample(example);
  const local = declaredNames(sf);
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
            const event = prop.name.getText().replace(/['"]/g, '');
            const type = prop.initializer.typeArguments?.[0];
            record(event, typeKeys(type), where);
            if (type && ts.isTypeLiteralNode(type))
              recordTypes(event, 'emitted', typeEntries(type, local), where);
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
            if (
              schema &&
              ts.isCallExpression(schema) &&
              schema.expression.getText() === 'v.object'
            ) {
              record(first.text, objectKeys(schema.arguments[0]), where);
              if (ts.isObjectLiteralExpression(schema.arguments[0]))
                recordTypes(
                  first.text,
                  'input of',
                  schemaEntries(schema.arguments[0], local),
                  where,
                );
            }
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
for (const [event, seen] of [...typeShapes].sort()) {
  if (seen.size < 2) continue;
  if (![...seen.values()].flat().some((w) => w.startsWith(filter))) continue;
  const parts = [...seen].map(([shape, where]) => `{${shape}} x${where.length} (${where[0]})`);
  report.push(`${event} has ${seen.size} value-type shapes: ${parts.join('; ')}`);
}

/** The repo's layout lint rules: its blank-line rules (lint-rules/readable-spacing.mjs) and `curly`. */
const LAYOUT_RULE = /^(livething\/|curly$)/;
const LAYOUT_CODE = /^(livething\(|eslint\(curly\))/;

/**
 * Runs the layout rules on every TS, JS and TSX fence, skipped ones too. A fence that does not parse
 * alone, such as a part of a function, is not checked.
 */
function checkLayout() {
  const dir = join(workDir, 'layout');
  mkdirSync(dir, { recursive: true });
  const repoConfig = JSON.parse(readFileSync(join(repo, '.oxlintrc.json'), 'utf8'));
  const rules = Object.fromEntries(
    Object.entries(repoConfig.rules).filter(([name]) => LAYOUT_RULE.test(name)),
  );
  const config = join(dir, 'oxlintrc.json');
  writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: [{ name: 'livething', specifier: join(repo, 'lint-rules/index.mjs') }],
      categories: { correctness: 'off' },
      rules,
    }),
  );

  const byFile = new Map();
  allExamples.forEach((example, index) => {
    if (filter && !example.page.startsWith(filter)) return;
    if (!['ts', 'typescript', 'js', 'tsx'].includes(example.lang)) return;
    const file = join(dir, `example-${index}.${example.lang === 'tsx' ? 'tsx' : 'ts'}`);
    writeFileSync(file, example.code);
    byFile.set(file, example);
  });

  const lint = (extra) => {
    const result = spawnSync(
      join(repo, 'node_modules/.bin/oxlint'),
      ['-c', config, '--disable-nested-config', '-f', 'json', ...extra, ...byFile.keys()],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error) throw result.error;

    return JSON.parse(result.stdout).diagnostics.filter((d) => LAYOUT_CODE.test(d.code ?? ''));
  };

  // One fix can uncover the next, such as a guard clause that ends a new group.
  let diagnostics = lint([]);
  for (let pass = 0; fixLayout && diagnostics.length > 0 && pass < 5; pass += 1) {
    lint(['--fix']);
    diagnostics = lint([]);
  }

  if (fixLayout) writeFixedFences(byFile);

  for (const d of diagnostics) {
    const example = byFile.get(resolve(dir, d.filename));
    if (example) add(example, d.labels[0].span.line - 1, `layout: ${d.message}`);
  }
}

/** Put each fixed example back in its fence. Fences are replaced from the bottom of the page up. */
function writeFixedFences(byFile) {
  const byPage = new Map();
  for (const [file, example] of byFile) {
    const fixed = readFileSync(file, 'utf8');
    if (fixed === example.code) continue;
    if (!byPage.has(example.page)) byPage.set(example.page, []);
    byPage.get(example.page).push({ example, fixed });
  }

  for (const [page, changes] of byPage) {
    const path = join(content, page);
    const lines = readFileSync(path, 'utf8').split('\n');
    changes.sort((a, b) => b.example.line - a.example.line);
    for (const { example, fixed } of changes) {
      const pad = ' '.repeat(example.indent);
      const body = fixed.split('\n').map((line) => (line ? pad + line : ''));
      lines.splice(example.line, example.lineCount, ...body);
    }

    writeFileSync(path, lines.join('\n'));
    console.log(`fixed layout in ${page}`);
  }

  // `curly`'s fix writes `{x}` on one line; Prettier lays the braces out.
  const pages = [...byPage.keys()].map((page) => join(content, page));
  if (pages.length > 0) {
    spawnSync(join(repo, 'node_modules/.bin/prettier'), ['--write', ...pages], { stdio: 'ignore' });
  }
}

checkLayout();

rmSync(workDir, { recursive: true, force: true });
const unique = [...new Set(report)];
console.log(unique.join('\n'));
console.log(`\n${examples.length} examples, ${unique.length} problems`);
process.exit(unique.length ? 1 : 0);
