import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export interface WskitCodegenOptions {
  generatedSuffix?: string;
  moduleName?: string;
  outDir?: string;
  rootDir?: string;
}

interface BoundNames {
  define: string;
  outgoing?: string;
  scheduled?: string;
  passive?: string;
  namespace?: string;
  channel?: string;
  scope?: string;
  replay?: string;
  incoming?: string;
  request?: string;
  intercept?: string;
}

interface ParsedScope {
  outgoing: Record<string, string>;
  scheduled: Record<string, string>;
  namespaces: Record<string, ParsedScope>;
  channels: Record<string, ParsedScope>;
  hasReplay: boolean;
  incomingEvents: string[];
  requestEvents: string[];
  postInterceptEvents: string[];
}

interface ParsedWskitModule {
  filePath: string;
  serverName: string;
  enabledFactories: string[];
  scope: ParsedScope;
}

const DEFAULT_GENERATED_SUFFIX = '.d.ts';
const DEFAULT_OUT_DIR = '.wskit';

function createEmptyScope(): ParsedScope {
  return {
    outgoing: {},
    scheduled: {},
    namespaces: {},
    channels: {},
    hasReplay: false,
    incomingEvents: [],
    requestEvents: [],
    postInterceptEvents: [],
  };
}

function isIdentifierNamed(node: ts.Node | undefined, name: string): node is ts.Identifier {
  return Boolean(node && ts.isIdentifier(node) && node.text === name);
}

function getStatementText(sourceFile: ts.SourceFile, node: ts.Node): string {
  return sourceFile.text.slice(node.getFullStart(), node.getEnd()).trim();
}

function findServerBinding(sourceFile: ts.SourceFile): {
  serverName: string;
  names: BoundNames;
  enabledFactories: string[];
} {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isObjectBindingPattern(declaration.name)) continue;
      if (!declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
      if (!isIdentifierNamed(declaration.initializer.expression, 'server')) continue;

      const [serverNameArg] = declaration.initializer.arguments;
      if (
        !serverNameArg ||
        (!ts.isStringLiteral(serverNameArg) && !ts.isNoSubstitutionTemplateLiteral(serverNameArg))
      ) {
        throw new Error('server(...) must receive a string literal name');
      }

      const names: BoundNames = {
        define: 'define',
      };
      const enabledFactories: string[] = [];

      const factoriesArg = declaration.initializer.arguments[1];
      if (factoriesArg && ts.isObjectLiteralExpression(factoriesArg)) {
        for (const property of factoriesArg.properties) {
          if (
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
            ts.isIdentifier(property.name)
          ) {
            enabledFactories.push(property.name.text);
          }
        }
      }

      for (const element of declaration.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const publicName =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
        const localName = element.name.text;
        if (publicName === 'define') names.define = localName;
        if (publicName === 'outgoing') names.outgoing = localName;
        if (publicName === 'scheduled') names.scheduled = localName;
        if (publicName === 'passive') names.passive = localName;
        if (publicName === 'namespace') names.namespace = localName;
        if (publicName === 'channel') names.channel = localName;
        if (publicName === 'scope') names.scope = localName;
        if (publicName === 'replay') names.replay = localName;
        if (publicName === 'incoming') names.incoming = localName;
        if (publicName === 'request') names.request = localName;
        if (publicName === 'intercept') names.intercept = localName;
      }

      return {
        serverName: serverNameArg.text,
        names,
        enabledFactories,
      };
    }
  }

  throw new Error('Could not find `const {...} = server("name", {...})`');
}

function findVariableInitializer(
  sourceFile: ts.SourceFile,
  name: string,
): ts.Expression | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      return declaration.initializer;
    }
  }

  return undefined;
}

function findDefaultExportExpression(sourceFile: ts.SourceFile): ts.Expression {
  for (const statement of sourceFile.statements) {
    if (!ts.isExportAssignment(statement)) continue;
    if (ts.isIdentifier(statement.expression)) {
      const resolved = findVariableInitializer(sourceFile, statement.expression.text);
      if (!resolved) {
        throw new Error(
          `Could not resolve default export identifier \`${statement.expression.text}\``,
        );
      }
      return resolved;
    }

    return statement.expression;
  }

  throw new Error('Expected a default export');
}

function extractOutgoingPayloadType(
  sourceFile: ts.SourceFile,
  arg: ts.Expression | undefined,
): string {
  if (!arg || !ts.isCallExpression(arg) || !arg.typeArguments?.length) {
    return 'unknown';
  }

  return arg.typeArguments[0] ? getStatementText(sourceFile, arg.typeArguments[0]) : 'unknown';
}

function extractTypeMarkerType(sourceFile: ts.SourceFile, arg: ts.Expression | undefined): string {
  if (!arg || !ts.isCallExpression(arg) || !isIdentifierNamed(arg.expression, 't')) {
    return 'unknown';
  }

  return arg.typeArguments?.[0] ? getStatementText(sourceFile, arg.typeArguments[0]) : 'unknown';
}

function extractScheduledPayloadType(
  sourceFile: ts.SourceFile,
  handlerOrDataArg: ts.Expression | undefined,
  optionsArg: ts.Expression | undefined,
): string {
  const directType = extractTypeMarkerType(sourceFile, handlerOrDataArg);
  if (directType !== 'unknown') return directType;
  if (!optionsArg || !ts.isObjectLiteralExpression(optionsArg)) return 'unknown';

  for (const property of optionsArg.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (!ts.isIdentifier(property.name) || property.name.text !== 'data') continue;
    return extractTypeMarkerType(sourceFile, property.initializer);
  }

  return 'unknown';
}

function extractReceivedEventName(arg: ts.Expression | undefined): string | undefined {
  if (!arg || !ts.isCallExpression(arg)) return undefined;
  if (!isIdentifierNamed(arg.expression, 'received')) return undefined;
  const [eventArg] = arg.arguments;
  if (!eventArg) return undefined;
  if (ts.isStringLiteral(eventArg) || ts.isNoSubstitutionTemplateLiteral(eventArg)) {
    return eventArg.text;
  }
  return undefined;
}

function collectScopeFromExpressions(
  sourceFile: ts.SourceFile,
  expressions: readonly ts.Expression[],
  names: BoundNames,
): ParsedScope {
  const scope = createEmptyScope();

  for (const expression of expressions) {
    if (!ts.isCallExpression(expression)) continue;

    if (names.outgoing && isIdentifierNamed(expression.expression, names.outgoing)) {
      const [eventArg, payloadArg] = expression.arguments;
      if (
        eventArg &&
        (ts.isStringLiteral(eventArg) || ts.isNoSubstitutionTemplateLiteral(eventArg))
      ) {
        scope.outgoing[eventArg.text] = extractOutgoingPayloadType(sourceFile, payloadArg);
      }
      continue;
    }

    if (
      (names.scheduled && isIdentifierNamed(expression.expression, names.scheduled)) ||
      isIdentifierNamed(expression.expression, 'scheduled')
    ) {
      const [taskArg, handlerOrDataArg, optionsArg] = expression.arguments;
      if (taskArg && (ts.isStringLiteral(taskArg) || ts.isNoSubstitutionTemplateLiteral(taskArg))) {
        scope.scheduled[taskArg.text] = extractScheduledPayloadType(
          sourceFile,
          handlerOrDataArg,
          optionsArg,
        );
      }
      continue;
    }

    if (
      (names.incoming && isIdentifierNamed(expression.expression, names.incoming)) ||
      isIdentifierNamed(expression.expression, 'incoming')
    ) {
      const eventName = extractReceivedEventName(expression.arguments[0]);
      if (eventName) scope.incomingEvents.push(eventName);
      continue;
    }

    if (
      (names.request && isIdentifierNamed(expression.expression, names.request)) ||
      isIdentifierNamed(expression.expression, 'request')
    ) {
      const [eventArg] = expression.arguments;
      if (
        eventArg &&
        (ts.isStringLiteral(eventArg) || ts.isNoSubstitutionTemplateLiteral(eventArg))
      ) {
        scope.requestEvents.push(eventArg.text);
      }
      continue;
    }

    if (
      (names.intercept && isIdentifierNamed(expression.expression, names.intercept)) ||
      isIdentifierNamed(expression.expression, 'intercept')
    ) {
      const [eventArg] = expression.arguments;
      if (
        eventArg &&
        (ts.isStringLiteral(eventArg) || ts.isNoSubstitutionTemplateLiteral(eventArg))
      ) {
        scope.postInterceptEvents.push(eventArg.text);
      }
      continue;
    }

    if (names.passive && isIdentifierNamed(expression.expression, names.passive)) {
      const nested = collectScopeFromExpressions(sourceFile, expression.arguments, names);
      Object.assign(scope.outgoing, nested.outgoing);
      Object.assign(scope.scheduled, nested.scheduled);
      Object.assign(scope.namespaces, nested.namespaces);
      Object.assign(scope.channels, nested.channels);
      scope.hasReplay ||= nested.hasReplay;
      scope.incomingEvents.push(...nested.incomingEvents);
      scope.requestEvents.push(...nested.requestEvents);
      scope.postInterceptEvents.push(...nested.postInterceptEvents);
      continue;
    }

    if (
      (names.replay && isIdentifierNamed(expression.expression, names.replay)) ||
      isIdentifierNamed(expression.expression, 'replay')
    ) {
      scope.hasReplay = true;
      continue;
    }

    if (names.namespace && isIdentifierNamed(expression.expression, names.namespace)) {
      const [nameArg, ...rest] = expression.arguments;
      if (nameArg && (ts.isStringLiteral(nameArg) || ts.isNoSubstitutionTemplateLiteral(nameArg))) {
        scope.namespaces[nameArg.text] = collectScopeFromExpressions(sourceFile, rest, names);
      }
      continue;
    }

    if (names.channel && isIdentifierNamed(expression.expression, names.channel)) {
      const [nameArg, ...rest] = expression.arguments;
      const channelKey = extractChannelKey(nameArg, names);
      if (channelKey) {
        scope.channels[channelKey] = collectScopeFromExpressions(sourceFile, rest, names);
      }
      continue;
    }
  }

  return scope;
}

function ctxRefForPath(parsed: ParsedWskitModule, path: readonly string[]): string {
  return [
    'WskitServerRegistry',
    JSON.stringify(parsed.serverName),
    ...path.map((segment) => JSON.stringify(segment)),
  ].reduce((acc, part, index) => (index === 0 ? acc : `${acc}[${part}]`), 'WskitServerRegistry');
}

interface ContextRefEntry {
  event: string;
  ctxRef: string;
}

function collectContextRefEntries(
  parsed: ParsedWskitModule,
  scope: ParsedScope,
  path: readonly string[] = [],
): {
  incoming: ContextRefEntry[];
  requests: ContextRefEntry[];
  postIntercepts: ContextRefEntry[];
} {
  const ctxRef = ctxRefForPath(parsed, [...path, 'ctx']);
  const incoming = scope.incomingEvents.map((event) => ({ event, ctxRef }));
  const requests = scope.requestEvents.map((event) => ({ event, ctxRef }));
  const postIntercepts = scope.postInterceptEvents.map((event) => ({ event, ctxRef }));

  for (const [namespace, child] of Object.entries(scope.namespaces)) {
    const nested = collectContextRefEntries(parsed, child, [...path, 'namespaces', namespace]);
    incoming.push(...nested.incoming);
    requests.push(...nested.requests);
    postIntercepts.push(...nested.postIntercepts);
  }

  for (const [channel, child] of Object.entries(scope.channels)) {
    const nested = collectContextRefEntries(parsed, child, [...path, 'channels', channel]);
    incoming.push(...nested.incoming);
    requests.push(...nested.requests);
    postIntercepts.push(...nested.postIntercepts);
  }

  return { incoming, requests, postIntercepts };
}

function renderContextRefMap(
  label: 'incomingContexts' | 'requestContexts' | 'postInterceptContexts',
  entries: readonly ContextRefEntry[],
  indent: string,
): string | undefined {
  if (!entries.length) return undefined;

  return [
    `${indent}${label}: {`,
    ...entries.map(({ event, ctxRef }) => `${indent}  ${JSON.stringify(event)}: ${ctxRef};`),
    `${indent}};`,
  ].join('\n');
}

function extractChannelKey(arg: ts.Expression | undefined, names: BoundNames): string | undefined {
  if (!arg) return undefined;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.text;
  }

  if (
    ts.isCallExpression(arg) &&
    ((names.scope && isIdentifierNamed(arg.expression, names.scope)) ||
      isIdentifierNamed(arg.expression, 'scope')) &&
    arg.arguments[0] &&
    (ts.isStringLiteral(arg.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(arg.arguments[0]))
  ) {
    return arg.arguments[0].text;
  }

  return undefined;
}

export function parseWskitModule(code: string, filePath: string): ParsedWskitModule {
  const sourceFile = ts.createSourceFile(
    filePath,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const { serverName, names, enabledFactories } = findServerBinding(sourceFile);
  const defaultExport = findDefaultExportExpression(sourceFile);

  if (
    !ts.isCallExpression(defaultExport) ||
    !isIdentifierNamed(defaultExport.expression, names.define)
  ) {
    throw new Error(
      'Default export must be a call to the `define` binding returned by server(...)',
    );
  }

  const scope = collectScopeFromExpressions(sourceFile, defaultExport.arguments, names);
  return {
    filePath,
    serverName,
    enabledFactories,
    scope,
  };
}

function renderSendMembers(outgoing: Record<string, string>, indent: string): string[] {
  const entries = Object.entries(outgoing);
  if (!entries.length) {
    return [
      `${indent}/** Send an event to the current connection. */`,
      `${indent}send(event: string, payload: unknown): void;`,
      '',
      `${indent}/** Broadcast an event to all other connections. */`,
      `${indent}broadcast(event: string, payload: unknown): void;`,
    ];
  }

  const result: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [event, payloadType] = entries[i]!;
    if (i > 0) result.push('');
    result.push(
      `${indent}/** Send a \`${event}\` event to the current connection. */`,
      `${indent}send(event: ${JSON.stringify(event)}, payload: ${payloadType}): void;`,
      '',
      `${indent}/** Broadcast a \`${event}\` event to all other connections. */`,
      `${indent}broadcast(event: ${JSON.stringify(event)}, payload: ${payloadType}): void;`,
    );
  }
  return result;
}

function renderSendToMembers(outgoing: Record<string, string>, indent: string): string[] {
  const entries = Object.entries(outgoing);

  if (!entries.length) {
    return [
      `${indent}/** Send an event to every connection that currently has the given tag. */`,
      `${indent}sendTo(tag: string, event: string, payload: unknown): void;`,
    ];
  }

  const result: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [event, payloadType] = entries[i]!;
    if (i > 0) result.push('');
    result.push(
      `${indent}/** Send a \`${event}\` event to every connection that currently has the given tag. */`,
      `${indent}sendTo(tag: string, event: ${JSON.stringify(event)}, payload: ${payloadType}): void;`,
    );
  }
  return result;
}

function renderReplayMembers(outgoing: Record<string, string>, indent: string): string[] {
  const entries = Object.entries(outgoing);
  if (!entries.length) {
    return [
      `${indent}/** Send a replay message directly with explicit wire metadata. */`,
      `${indent}sendReplay(event: string, payload: unknown, meta: { seq: number; messageId: string }): void;`,
    ];
  }

  const result: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [event, payloadType] = entries[i]!;
    if (i > 0) result.push('');
    result.push(
      `${indent}/** Send a \`${event}\` replay message directly with explicit wire metadata. */`,
      `${indent}sendReplay(event: ${JSON.stringify(event)}, payload: ${payloadType}, meta: { seq: number; messageId: string }): void;`,
    );
  }
  return result;
}

function renderScheduledMembers(tasks: Record<string, string>, indent: string): string[] {
  const entries = Object.entries(tasks);
  if (!entries.length) {
    return [
      `${indent}/** Schedule a task to run at a specific time. */`,
      `${indent}schedule(taskId: string, options: { time: number; data?: unknown }): void;`,
      '',
      `${indent}/** Cancel a previously scheduled task. */`,
      `${indent}cancelScheduled(taskId: string, filter?: Record<string, unknown>): void;`,
    ];
  }

  const result: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [taskId, payloadType] = entries[i]!;
    if (i > 0) result.push('');
    result.push(
      `${indent}/** Schedule the \`${taskId}\` task to run at a specific time. */`,
      `${indent}schedule(taskId: ${JSON.stringify(taskId)}, options: { time: number; data?: ${payloadType} }): void;`,
      '',
      `${indent}/** Cancel a previously scheduled \`${taskId}\` task. */`,
      `${indent}cancelScheduled(taskId: ${JSON.stringify(taskId)}, filter?: ${payloadType} extends Record<string, unknown> ? Partial<${payloadType}> : Record<string, unknown>): void;`,
    );
  }
  return result;
}

function renderBaseCtxInterfaceName(parsed: ParsedWskitModule): string {
  const camel = parsed.serverName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return `Wskit${camel[0]!.toUpperCase()}${camel.slice(1)}Ctx`;
}

function renderBaseCtxInterface(parsed: ParsedWskitModule): string {
  const name = renderBaseCtxInterfaceName(parsed);
  const indent = '    ';
  const lines: string[] = [
    `${indent}/** Unique ID for this connection. Store it when you need to target this client later. */`,
    `${indent}readonly id: string;`,
    '',
    `${indent}/** Per-connection metadata set during the upgrade step (auth, session info, etc). */`,
    `${indent}readonly meta: Record<string, unknown>;`,
    '',
    `${indent}/** Bytes still queued to be sent. Useful for detecting backpressure. */`,
    `${indent}readonly bufferedAmount: number;`,
    '',
    `${indent}/** Latest round-trip latency in ms. \`null\` until enough ping/pong data is collected. */`,
    `${indent}readonly latency: number | null;`,
    '',
    `${indent}/** Connection health derived from recent latency: < 50 ms excellent, 50–150 ms good, 150–500 ms degraded, > 500 ms poor. */`,
    `${indent}readonly quality: 'excellent' | 'good' | 'degraded' | 'poor';`,
    '',
    `${indent}/** Current tags on this connection. Use \`tag()\` / \`untag()\` to modify. */`,
    `${indent}readonly tags: readonly string[];`,
    '',
    `${indent}/** Attach a tag so this connection can be targeted later via \`sendTo()\`. */`,
    `${indent}tag(label: string): void;`,
    '',
    `${indent}/** Remove a tag from this connection. */`,
    `${indent}untag(label: string): void;`,
  ];

  if (parsed.enabledFactories.includes('_outgoing')) {
    lines.push('', ...renderSendMembers(parsed.scope.outgoing, indent));
  }

  lines.push('', ...renderSendToMembers(parsed.scope.outgoing, indent));

  if (parsed.enabledFactories.includes('_ack')) {
    lines.push(
      '',
      `${indent}/** Confirm receipt of the current incoming message. Only available when \`ack()\` is registered. */`,
      `${indent}ack(): void;`,
    );
  }

  if (parsed.enabledFactories.includes('_replay')) {
    lines.push('', ...renderReplayMembers(parsed.scope.outgoing, indent));
  }

  if (parsed.enabledFactories.includes('_scheduled')) {
    lines.push('', ...renderScheduledMembers(parsed.scope.scheduled, indent));
  }

  return [`  interface ${name} {`, ...lines, '  }'].join('\n');
}

function scopeInterfaceName(parsed: ParsedWskitModule, scopeName: string): string {
  const baseName = renderBaseCtxInterfaceName(parsed);
  const camel = scopeName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return `${baseName}${camel[0]!.toUpperCase()}${camel.slice(1)}`;
}

function renderScopeInterface(
  kind: 'namespace' | 'channel',
  name: string,
  scope: ParsedScope,
  parsed: ParsedWskitModule,
): string {
  const ifaceName = scopeInterfaceName(parsed, name);
  const baseName = renderBaseCtxInterfaceName(parsed);
  const indent = '    ';

  const lines: string[] = [
    kind === 'namespace'
      ? `${indent}/** Scoped API for the \`${name}\` namespace. */`
      : `${indent}/** Scoped API for the \`${name}\` channel. Send and broadcast events within this channel. */`,
    `${indent}readonly ${kind}: {`,
    kind === 'namespace'
      ? `${indent}  /** Always \`${JSON.stringify(name)}\` for this namespace. */`
      : `${indent}  /** The concrete channel name matched at runtime. */`,
    `${indent}  readonly name: ${kind === 'namespace' ? JSON.stringify(name) : 'string'};`,
  ];

  if (parsed.enabledFactories.includes('_outgoing')) {
    for (const [event, payloadType] of Object.entries(scope.outgoing)) {
      lines.push(
        '',
        `${indent}  /** Send a \`${event}\` event scoped to this ${kind}. */`,
        `${indent}  send(event: ${JSON.stringify(event)}, payload: ${payloadType}): void;`,
        '',
        `${indent}  /** Broadcast a \`${event}\` event scoped to this ${kind}. */`,
        `${indent}  broadcast(event: ${JSON.stringify(event)}, payload: ${payloadType}): void;`,
      );
    }
  }

  if (scope.hasReplay) {
    const replayEntries = Object.entries(scope.outgoing);
    if (replayEntries.length) {
      for (const [event, payloadType] of replayEntries) {
        lines.push(
          '',
          `${indent}  /** Send a \`${event}\` replay message scoped to this ${kind}. */`,
          `${indent}  sendReplay(event: ${JSON.stringify(event)}, payload: ${payloadType}, meta: { seq: number; messageId: string }): void;`,
        );
      }
    } else {
      lines.push(
        '',
        `${indent}  /** Send a replay message scoped to this ${kind}. */`,
        `${indent}  sendReplay(event: string, payload: unknown, meta: { seq: number; messageId: string }): void;`,
      );
    }
  }

  lines.push(`${indent}};`);

  return [`  interface ${ifaceName} extends ${baseName} {`, ...lines, '  }'].join('\n');
}

function renderTopLevelCtx(parsed: ParsedWskitModule): string {
  return renderBaseCtxInterfaceName(parsed);
}

function renderScopeCtxRef(name: string, parsed: ParsedWskitModule): string {
  return scopeInterfaceName(parsed, name);
}

function renderOutgoingMap(outgoing: Record<string, string>, indent: string): string {
  const entries = Object.entries(outgoing);
  if (!entries.length) return `${indent}{}`;

  return [
    `${indent}{`,
    ...entries.map(([event, typeText]) => `${indent}  ${JSON.stringify(event)}: ${typeText};`),
    `${indent}}`,
  ].join('\n');
}

function renderScopedMap(
  label: 'namespaces' | 'channels',
  values: Record<string, ParsedScope>,
  parsed: ParsedWskitModule,
  indent: string,
): string | undefined {
  const entries = Object.entries(values);
  if (!entries.length) return undefined;

  return [
    `${indent}${label}: {`,
    ...entries.map(
      ([name, scope]) =>
        `${indent}  ${JSON.stringify(name)}: ${renderScope(label === 'namespaces' ? 'namespace' : 'channel', name, scope, parsed, `${indent}  `)};`,
    ),
    `${indent}};`,
  ].join('\n');
}

function renderScope(
  _kind: 'namespace' | 'channel',
  name: string,
  scope: ParsedScope,
  parsed: ParsedWskitModule,
  indent: string,
): string {
  const lines = [
    `${indent}{`,
    `${indent}  ctx: ${renderScopeCtxRef(name, parsed)};`,
    `${indent}  outgoing: ${renderOutgoingMap(scope.outgoing, `${indent}  `)};`,
  ];

  const namespaces = renderScopedMap('namespaces', scope.namespaces, parsed, `${indent}  `);
  if (namespaces) lines.push(namespaces);

  const channels = renderScopedMap('channels', scope.channels, parsed, `${indent}  `);
  if (channels) lines.push(channels);

  lines.push(`${indent}}`);
  return lines.join('\n');
}

function renderServerEntry(parsed: ParsedWskitModule): string {
  const lines = ['    {'];

  const topLevelCtx = renderTopLevelCtx(parsed);
  lines.push(`      ctx: ${topLevelCtx};`);

  lines.push(`      outgoing: ${renderOutgoingMap(parsed.scope.outgoing, '      ')};`);

  const namespaces = renderScopedMap('namespaces', parsed.scope.namespaces, parsed, '      ');
  if (namespaces) lines.push(namespaces);

  const channels = renderScopedMap('channels', parsed.scope.channels, parsed, '      ');
  if (channels) lines.push(channels);

  const contextRefs = collectContextRefEntries(parsed, parsed.scope);
  const incomingContexts = renderContextRefMap('incomingContexts', contextRefs.incoming, '      ');
  if (incomingContexts) lines.push(incomingContexts);

  const requestContexts = renderContextRefMap('requestContexts', contextRefs.requests, '      ');
  if (requestContexts) lines.push(requestContexts);

  const postInterceptContexts = renderContextRefMap(
    'postInterceptContexts',
    contextRefs.postIntercepts,
    '      ',
  );
  if (postInterceptContexts) lines.push(postInterceptContexts);

  lines.push('    }');
  return lines.join('\n');
}

function collectScopeInterfaces(parsed: ParsedWskitModule, scope: ParsedScope): string[] {
  const interfaces: string[] = [];

  for (const [name, child] of Object.entries(scope.namespaces)) {
    interfaces.push(renderScopeInterface('namespace', name, child, parsed));
    interfaces.push(...collectScopeInterfaces(parsed, child));
  }

  for (const [name, child] of Object.entries(scope.channels)) {
    interfaces.push(renderScopeInterface('channel', name, child, parsed));
    interfaces.push(...collectScopeInterfaces(parsed, child));
  }

  return interfaces;
}

export function generateWskitDeclarationText(
  parsed: ParsedWskitModule,
  options: WskitCodegenOptions = {},
): string {
  void options;

  const baseInterface = renderBaseCtxInterface(parsed);
  const scopeInterfaces = collectScopeInterfaces(parsed, parsed.scope);
  const allInterfaces = [baseInterface, ...scopeInterfaces].join('\n\n');
  return `export {};\n\ndeclare global {\n  interface WskitServerRegistry {\n    ${JSON.stringify(parsed.serverName)}: ${renderServerEntry(parsed)};\n  }\n\n${allInterfaces}\n}\n`;
}

export function toGeneratedFilePath(
  sourceFilePath: string,
  options: WskitCodegenOptions = {},
): string {
  const suffix = options.generatedSuffix ?? DEFAULT_GENERATED_SUFFIX;
  const siblingPath = sourceFilePath.replace(/\.ts$/, suffix);

  if (!options.outDir) return siblingPath;

  const rootDir = options.rootDir ? resolve(options.rootDir) : dirname(sourceFilePath);
  const outputDir = options.outDir ? resolve(options.outDir) : resolve(rootDir, DEFAULT_OUT_DIR);
  const relativeSourcePath = relative(rootDir, sourceFilePath);

  return join(outputDir, relativeSourcePath.replace(/\.ts$/, suffix));
}

export function toServerName(filePath: string): string {
  return basename(filePath).replace(/\.wskit\.ts$/, '');
}

export function createDefaultWskitTemplate(filePath: string): string {
  const serverName = toServerName(filePath);

  return `import { received, server, t } from '@wskit/server-codegen';
import { incoming as _incoming } from '@wskit/server-codegen/incoming';
import { outgoing as _outgoing } from '@wskit/server-codegen/outgoing';

const { define, incoming, outgoing } = server('${serverName}', {
  _incoming,
  _outgoing,
});

export default define(
  outgoing('message', t<{ text: string }>()),
  incoming(
    received('send-message', (value: unknown) => value as { text: string }),
    async (_ctx, payload) => {
      console.log(payload.text);
    },
  ),
);
`;
}

export async function ensureWskitTemplate(filePath: string): Promise<boolean> {
  const code = await fs.readFile(filePath, 'utf8');
  if (code.trim().length > 0) return false;

  await fs.writeFile(filePath, createDefaultWskitTemplate(filePath), 'utf8');
  return true;
}

export async function writeGeneratedDeclarationFile(
  filePath: string,
  options: WskitCodegenOptions = {},
): Promise<string> {
  const code = await fs.readFile(filePath, 'utf8');
  const parsed = parseWskitModule(code, filePath);
  const output = generateWskitDeclarationText(parsed, options);
  const generatedPath = toGeneratedFilePath(filePath, options);
  const existing = await fs.readFile(generatedPath, 'utf8').catch(() => null);

  if (existing !== output) {
    await fs.mkdir(dirname(generatedPath), { recursive: true });
    await fs.writeFile(generatedPath, output, 'utf8');
  }

  return generatedPath;
}

export async function removeGeneratedDeclarationFile(
  filePath: string,
  options: WskitCodegenOptions = {},
): Promise<void> {
  const generatedPath = toGeneratedFilePath(filePath, options);
  await fs.rm(generatedPath, { force: true });
}

export function formatGeneratedPathForLog(root: string, filePath: string): string {
  return relative(root, filePath).replaceAll('\\', '/');
}
