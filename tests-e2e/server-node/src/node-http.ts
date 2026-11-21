import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, setup, websocket } from '@livething/server-node';
import { hasCapability } from '@livething/server/adapters';
import type { NodeEndpointBinding, NodeEndpointOptions } from '@livething/server-node';
import type { ServerDefinition } from '@livething/server/adapters';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { FEATURE_DEFINITIONS } from './handlers.ts';

// Deno cannot load better-sqlite3, so there each fixture gets a node:sqlite database. Node
// never imports node:sqlite here.
const DatabaseSync = 'Deno' in globalThis ? (await import('node:sqlite')).DatabaseSync : undefined;

type AnyAdminMethod = (...args: unknown[]) => unknown;
type AnyAdmin = Record<string, AnyAdminMethod>;

export interface Fixture {
  service: FixtureService;
  sockets: Set<Duplex>;
  leases: Set<string>;
  activeHttpRequests: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  shutdown?: Promise<void>;
}

export interface FixtureService<TEndpoint = unknown> {
  readonly endpoint: TEndpoint;
  readonly ready: Promise<void>;
  readonly keepAlive?: boolean;
  admin(): Promise<unknown>;
  shutdown(): Promise<void>;
}

type FixtureBinding = (
  definition: ServerDefinition,
  options: NodeEndpointOptions,
) => FixtureService;

let bindFixture: FixtureBinding | undefined;

export function configureFixtureBinding(binding: FixtureBinding): void {
  bindFixture = binding;
}

function bindNodeFixture(
  definition: ServerDefinition,
  options: NodeEndpointOptions,
): FixtureService {
  const livething = setup();
  const database = DatabaseSync && new DatabaseSync(String(options.sql));
  const endpoint = livething.bind(definition, database ? { ...options, sql: database } : options);

  return {
    endpoint,
    ready: endpoint.ready(),
    admin: endpoint.admin,
    shutdown: async () => {
      await livething.shutdown();
      database?.close();
    },
  };
}

const stateRoot = mkdtempSync(join(tmpdir(), 'livething-node-e2e-'));
const fixtures = new Map<string, Fixture>();
const fixtureCreations = new Map<string, Promise<Fixture>>();
const IDLE_FIXTURE_TIMEOUT_MS = 1_000;

function fixtureKey(route: string, room: string): string {
  return `${route}\u0000${room}`;
}

function databasePath(route: string, room: string): string {
  const digest = createHash('sha256').update(fixtureKey(route, room)).digest('hex');
  return join(stateRoot, `${digest}.sqlite`);
}

function scheduleIdleFixtureShutdown(key: string, fixture: Fixture): void {
  if (fixture.idleTimer) return;

  fixture.idleTimer = setTimeout(() => {
    fixture.idleTimer = undefined;
    if (
      fixture.sockets.size === 0 &&
      fixture.leases.size === 0 &&
      fixture.activeHttpRequests === 0
    ) {
      void shutdownKnownFixture(key, fixture);
    }
  }, IDLE_FIXTURE_TIMEOUT_MS);
  fixture.idleTimer.unref();
}

async function shutdownKnownFixture(key: string, fixture: Fixture): Promise<void> {
  if (fixtures.get(key) !== fixture) return;

  if (fixture.shutdown) return fixture.shutdown;

  if (fixture.idleTimer) clearTimeout(fixture.idleTimer);
  fixture.shutdown = fixture.service.shutdown().finally(() => {
    if (fixtures.get(key) === fixture) fixtures.delete(key);
  });

  return fixture.shutdown;
}

export async function getFixture(route: string, room: string): Promise<Fixture> {
  const key = fixtureKey(route, room);
  const current = fixtures.get(key);
  if (current) {
    if (!current.shutdown) return current;
  }

  const existingCreation = fixtureCreations.get(key);
  if (existingCreation) return existingCreation;

  const creation = (async () => {
    if (current?.shutdown) await current.shutdown;

    const replacement = fixtures.get(key);
    if (replacement && !replacement.shutdown) return replacement;

    const definition = FEATURE_DEFINITIONS[route];
    if (!definition) throw new Error(`No Node fixture is registered for ${route}`);

    if (!bindFixture) throw new Error('[livething] E2E fixture binding was not configured');

    // Every fixture with keepalive() offers both transports, so one suite runs over each.
    const service = bindFixture(definition, {
      sql: databasePath(route, room),
      ...(hasCapability(definition, 'keepalive') ? { transports: [websocket(), http()] } : {}),
    });
    const fixture = {
      service,
      sockets: new Set<Duplex>(),
      leases: new Set<string>(),
      activeHttpRequests: 0,
    };

    fixtures.set(key, fixture);
    if (!service.keepAlive) scheduleIdleFixtureShutdown(key, fixture);

    return fixture;
  })().finally(() => {
    if (fixtureCreations.get(key) === creation) fixtureCreations.delete(key);
  });
  fixtureCreations.set(key, creation);

  return creation;
}

async function acquireHttpFixture(
  route: string,
  room: string,
): Promise<{ fixture: Fixture; release(): void }> {
  const key = fixtureKey(route, room);
  const fixture = await getFixture(route, room);
  if (fixture.idleTimer) clearTimeout(fixture.idleTimer);
  fixture.idleTimer = undefined;
  fixture.activeHttpRequests += 1;

  let released = false;

  return {
    fixture,
    release() {
      if (released) return;

      released = true;
      fixture.activeHttpRequests -= 1;
      if (!fixture.service.keepAlive && fixture.sockets.size === 0 && fixture.leases.size === 0) {
        scheduleIdleFixtureShutdown(key, fixture);
      }
    },
  };
}

function releaseFixtureLease(route: string, room: string, lease: string): void {
  const key = fixtureKey(route, room);
  const fixture = fixtures.get(key);
  if (!fixture) return;

  fixture.leases.delete(lease);
  if (
    !fixture.service.keepAlive &&
    fixture.sockets.size === 0 &&
    fixture.leases.size === 0 &&
    fixture.activeHttpRequests === 0
  ) {
    scheduleIdleFixtureShutdown(key, fixture);
  }
}

async function adminOf(fixture: Fixture): Promise<AnyAdmin> {
  return (await fixture.service.admin()) as unknown as AnyAdmin;
}

async function shutdownFixture(route: string, room: string): Promise<void> {
  const key = fixtureKey(route, room);
  const fixture = fixtures.get(key);
  if (fixture) await shutdownKnownFixture(key, fixture);
}

interface AdminOpArgs {
  text: string;
  userId: string;
  channel: string;
  url: URL;
}

type AdminOperation = (admin: AnyAdmin, args: AdminOpArgs) => Promise<unknown> | unknown;

const ADMIN_OPERATIONS: Record<string, AdminOperation> = {
  'count-now': (admin) => admin.countNow(),
  'who-is-online': (admin) => admin.whoIsOnline(),
  'connection-ids-of': (admin, { userId }) => admin.connectionIdsOf(userId),
  'poke-connection': (admin, { text, url }) =>
    admin.pokeConnection(url.searchParams.get('connectionId') ?? '', text),
  'close-connection': (admin, { url }) =>
    admin.closeConnection(
      url.searchParams.get('connectionId') ?? '',
      Number(url.searchParams.get('code') ?? '1000'),
      url.searchParams.get('reason') ?? '',
    ),
  'notify-user': (admin, { text, userId }) => admin.notifyUser(userId, text),
  'boot-user': (admin, { userId }) => admin.bootUser(userId) ?? null,
  'announce-in': (admin, { channel, text }) => admin.announceIn(channel, text) ?? null,
  'members-of': (admin, { channel }) => admin.membersOf(channel),
  'kick-from': async (admin, { channel, userId }) =>
    (await admin.kickFrom(channel, userId)) ?? null,
  'schedule-announce': (admin, { text, url }) =>
    admin.scheduleAnnounce(Number(url.searchParams.get('delayMs') ?? '50'), text) ?? null,
  'cancel-announce': (admin) => admin.cancelAnnounce() ?? null,
  'write-note': (admin, { text }) => admin.writeNote(text) ?? null,
  'read-notes': (admin) => admin.readNotes(),
  'put-flag': async (admin, { text, url }) =>
    (await admin.putFlag(url.searchParams.get('key') ?? '', text)) ?? null,
  'get-flag': (admin, { url }) => admin.getFlag(url.searchParams.get('key') ?? ''),
  'log-something': (admin, { text }) => admin.logSomething(text) ?? null,
  'has-platform': (admin) => admin.hasPlatform(),
  'open-poll': (admin, { text }) =>
    (admin.plugin('e2e:polls') as { openPoll(question: string): string }).openPoll(text),
};

function runAdminOp(admin: AnyAdmin, op: string, args: AdminOpArgs): Promise<unknown> | unknown {
  const operation = ADMIN_OPERATIONS[op];
  return operation ? operation(admin, args) : UNKNOWN_OP;
}

const UNKNOWN_OP = Symbol('unknown-op');

function writeText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function roomFrom(url: URL): string {
  return url.searchParams.get('room') ?? 'default';
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const room = roomFrom(url);
  let releaseFixture: (() => void) | undefined;

  async function getRequestFixture(route: string): Promise<Fixture> {
    const lease = await acquireHttpFixture(route, room);
    releaseFixture = lease.release;
    return lease.fixture;
  }

  try {
    if (url.pathname === '/__health') {
      writeText(response, 200, 'ok');
      return;
    }

    if (url.pathname === '/ws/__fixtures/release') {
      const route = url.searchParams.get('route') ?? '';
      const lease = url.searchParams.get('lease') ?? '';
      if (FEATURE_DEFINITIONS[route] && lease) releaseFixtureLease(route, room, lease);
      writeText(response, 204, '');
      return;
    }

    if (url.pathname === '/ws/plugins/shutdown') {
      await shutdownFixture('/ws/plugins', room);
      writeText(response, 204, '');
      return;
    }

    if (url.pathname === '/ws/admin/purge' || url.pathname === '/ws/admin/announce') {
      const fixture = await getRequestFixture('/ws/admin');
      await fixture.service.ready;
      const admin = await adminOf(fixture);
      if (url.pathname.endsWith('/purge')) {
        await admin.purgeUser(url.searchParams.get('userId') ?? '');
      } else {
        await admin.announce(url.searchParams.get('text') ?? '');
      }

      writeText(response, 204, '');

      return;
    }

    if (url.pathname.startsWith('/ws/admin/api/')) {
      const fixture = await getRequestFixture('/ws/admin');
      await fixture.service.ready;
      const result = await runAdminOp(
        await adminOf(fixture),
        url.pathname.slice('/ws/admin/api/'.length),
        {
          text: url.searchParams.get('text') ?? '',
          userId: url.searchParams.get('userId') ?? '',
          channel: url.searchParams.get('channel') ?? 'lobby',
          url,
        },
      );
      if (result === UNKNOWN_OP) {
        writeText(response, 404, `unknown admin op: ${url.pathname}`);
      } else {
        writeJson(response, 200, { result });
      }

      return;
    }

    if (url.pathname === '/ws/lifecycle-hooks/shutdown') {
      await shutdownFixture('/ws/lifecycle-hooks', room);
      writeText(response, 204, '');
      return;
    }

    if (
      url.pathname === '/ws/sequence/restart' ||
      url.pathname === '/ws/persistence/restart' ||
      url.pathname === '/ws/scheduled/restart' ||
      url.pathname === '/ws/inbox-retention/restart' ||
      url.pathname === '/ws/receipts/restart' ||
      url.pathname === '/ws/durable-config/restart'
    ) {
      await shutdownFixture(url.pathname.slice(0, url.pathname.lastIndexOf('/')), room);
      writeText(response, 204, '');
      return;
    }

    if (url.pathname === '/ws/receipts/seed-stale') {
      const fixture = await getRequestFixture('/ws/receipts');
      await fixture.service.ready;
      const admin = await adminOf(fixture);
      await admin.seedStaleReceipt();
      writeText(response, 204, '');

      return;
    }

    if (url.pathname === '/ws/receipts/stale-count') {
      const fixture = await getRequestFixture('/ws/receipts');
      await fixture.service.ready;
      const admin = await adminOf(fixture);
      writeJson(response, 200, { count: await admin.staleReceiptCount() });
      return;
    }

    if (url.pathname === '/ws/receipts/drop-inbox') {
      const fixture = await getRequestFixture('/ws/receipts');
      await fixture.service.ready;
      const admin = await adminOf(fixture);
      await admin.dropInboxTable();
      writeText(response, 204, '');

      return;
    }

    if (url.pathname === '/ws/receipts/receivers') {
      const fixture = await getRequestFixture('/ws/receipts');
      await fixture.service.ready;
      const admin = await adminOf(fixture);
      const users = await admin.receiptUsers(
        url.searchParams.get('channel') ?? 'chat',
        Number(url.searchParams.get('seq') ?? 0),
      );
      writeJson(response, 200, { users });

      return;
    }

    if (url.pathname === '/ws/receipts/purge') {
      const fixture = await getRequestFixture('/ws/receipts');
      await fixture.service.ready;
      const admin = await adminOf(fixture);
      try {
        await admin.purgeUser('alice');
        writeText(response, 204, '');
      } catch {
        writeText(response, 500, '');
      }

      return;
    }

    // A stream, its POSTs and the CORS preflight. An open stream holds the room like a socket.
    if (FEATURE_DEFINITIONS[url.pathname]) {
      const fixture = await getRequestFixture(url.pathname);
      await fixture.service.ready;
      const release = releaseFixture;
      releaseFixture = undefined;
      response.once('close', () => release?.());

      const lease = url.searchParams.get('__livethingFixtureLease');
      if (lease) fixture.leases.add(lease);

      (fixture.service.endpoint as NodeEndpointBinding<unknown>).handle(request, response);
      return;
    }

    writeText(response, 404, 'not found');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    writeText(response, 500, message);
  } finally {
    releaseFixture?.();
  }
}

export async function handleFetchRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let status = 200;
  const headers = new Headers();
  let body = '';
  const response = {
    writeHead(code: number, values: Record<string, string | number>) {
      status = code;
      for (const [name, value] of Object.entries(values)) headers.set(name, String(value));
      return response;
    },
    end(value?: string | Buffer) {
      if (value) body += value.toString();
    },
  } as unknown as ServerResponse;

  const incoming = {
    url: `${url.pathname}${url.search}`,
    headers: { host: url.host },
  } as IncomingMessage;

  await handleRequest(incoming, response);

  return new Response(status === 204 || status === 205 || status === 304 ? null : body, {
    status,
    headers,
  });
}

export async function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  if (!FEATURE_DEFINITIONS[url.pathname]) {
    socket.destroy();
    return;
  }

  const room = roomFrom(url);
  const key = fixtureKey(url.pathname, room);
  const fixture = await getFixture(url.pathname, room);
  if (fixture.idleTimer) clearTimeout(fixture.idleTimer);
  fixture.idleTimer = undefined;

  fixture.sockets.add(socket);
  const lease = url.searchParams.get('__livethingFixtureLease');
  if (lease) fixture.leases.add(lease);
  socket.once('close', () => {
    fixture.sockets.delete(socket);
    if (
      !fixture.service.keepAlive &&
      fixture.leases.size === 0 &&
      fixture.activeHttpRequests === 0
    ) {
      scheduleIdleFixtureShutdown(key, fixture);
    }
  });
  (fixture.service.endpoint as NodeEndpointBinding<unknown>).upgrade(request, socket, head);
}

export async function shutdownAll(root: Server): Promise<void> {
  const current = [...fixtures.values()];
  fixtures.clear();
  await Promise.allSettled(current.map((fixture) => fixture.service.shutdown()));
  await new Promise<void>((resolve) => root.close(() => resolve()));
}

export function attachUpgradeHandler(root: Server): void {
  root.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket, head).catch(() => socket.destroy());
  });
}

export function listen(root: Server, name: string): void {
  process.once('SIGINT', () => void shutdownAll(root));
  process.once('SIGTERM', () => void shutdownAll(root));
  const port = Number(process.env.LIVETHING_E2E_SERVER_PORT ?? 8787);
  root.listen(port, '127.0.0.1', () => {
    console.log(`LiveThing ${name} e2e server listening on 127.0.0.1:${port}`);
  });
}

process.once('exit', () => rmSync(stateRoot, { recursive: true, force: true }));

if (process.argv[1]?.endsWith('/node-http.ts')) {
  configureFixtureBinding(bindNodeFixture);
  const root = createServer((request, response) => {
    void handleRequest(request, response);
  });

  attachUpgradeHandler(root);
  listen(root, 'node:http');
}
