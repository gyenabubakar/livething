import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeServer } from '@wskit/server-node';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { FEATURE_ROUTES } from './fixtures.ts';

type AnyAdminMethod = (...args: unknown[]) => unknown;
type AnyAdmin = Record<string, AnyAdminMethod>;

interface Fixture {
  service: NodeServer<unknown, unknown>;
  transport: Server;
}

const stateRoot = mkdtempSync(join(tmpdir(), 'wskit-node-e2e-'));
const fixtures = new Map<string, Fixture>();

function fixtureKey(route: string, room: string): string {
  return `${route}\u0000${room}`;
}

function databasePath(route: string, room: string): string {
  const digest = createHash('sha256').update(fixtureKey(route, room)).digest('hex');
  return join(stateRoot, `${digest}.sqlite`);
}

function getFixture(route: string, room: string): Fixture {
  const key = fixtureKey(route, room);
  const current = fixtures.get(key);
  if (current) return current;

  const spec = FEATURE_ROUTES[route];
  if (!spec) throw new Error(`No Node fixture is registered for ${route}`);

  const transport = createServer();
  const service = spec.create({
    server: transport,
    sql: databasePath(route, room),
    env: { NODE_ENV: 'test', PLUGIN_LABEL: 'node' },
    shutdownOnSignal: false,
  });
  const fixture = { service, transport };
  fixtures.set(key, fixture);
  return fixture;
}

async function adminOf(fixture: Fixture): Promise<AnyAdmin> {
  return (await fixture.service.admin()) as unknown as AnyAdmin;
}

async function shutdownFixture(route: string, room: string): Promise<void> {
  const key = fixtureKey(route, room);
  const fixture = getFixture(route, room);
  fixtures.delete(key);
  await fixture.service.shutdown();
}

interface AdminOpArgs {
  text: string;
  userId: string;
  channel: string;
  url: URL;
}

async function runAdminOp(admin: AnyAdmin, op: string, args: AdminOpArgs): Promise<unknown> {
  const { text, userId, channel, url } = args;
  switch (op) {
    case 'count-now':
      return admin.countNow();
    case 'who-is-online':
      return admin.whoIsOnline();
    case 'connection-ids-of':
      return admin.connectionIdsOf(userId);
    case 'poke-connection':
      return admin.pokeConnection(url.searchParams.get('connectionId') ?? '', text);
    case 'close-connection':
      return admin.closeConnection(
        url.searchParams.get('connectionId') ?? '',
        Number(url.searchParams.get('code') ?? '1000'),
        url.searchParams.get('reason') ?? '',
      );
    case 'notify-user':
      return admin.notifyUser(userId, text);
    case 'boot-user':
      return admin.bootUser(userId) ?? null;
    case 'announce-in':
      return admin.announceIn(channel, text) ?? null;
    case 'members-of':
      return admin.membersOf(channel);
    case 'kick-from':
      return (await admin.kickFrom(channel, userId)) ?? null;
    case 'schedule-announce':
      return admin.scheduleAnnounce(Number(url.searchParams.get('delayMs') ?? '50'), text) ?? null;
    case 'cancel-announce':
      return admin.cancelAnnounce() ?? null;
    case 'write-note':
      return admin.writeNote(text) ?? null;
    case 'read-notes':
      return admin.readNotes();
    case 'put-flag':
      return (await admin.putFlag(url.searchParams.get('key') ?? '', text)) ?? null;
    case 'get-flag':
      return admin.getFlag(url.searchParams.get('key') ?? '');
    case 'env-keys':
      return admin.envKeys();
    case 'log-something':
      return admin.logSomething(text) ?? null;
    case 'defer-note':
      return admin.deferNote(text) ?? null;
    case 'has-platform':
      return admin.hasPlatform();
    default:
      return UNKNOWN_OP;
  }
}

async function runAdminBuiltIn(admin: AnyAdmin, op: string, args: AdminOpArgs): Promise<unknown> {
  const { text, userId, channel, url } = args;
  switch (op) {
    case 'connection-count':
      return admin.connectionCount();
    case 'list-connections':
      return ((await admin.listConnections()) as Record<string, unknown>[]).map((info) => ({
        id: info.id,
        userId: info.userId,
        hasRef: 'ref' in info,
      }));
    case 'send-to-connection':
      return admin.sendToConnection(url.searchParams.get('connectionId') ?? '', 'poked', { text });
    case 'send-to-user':
      return admin.sendToUser(userId, 'notified', { text });
    case 'close-user':
      return admin.closeUser(userId, 4321, 'booted by admin') ?? null;
    case 'broadcast':
      return admin.broadcast('announced', { text }) ?? null;
    case 'channel-broadcast':
      return admin.channelBroadcast(channel, 'room-notice', { text }) ?? null;
    case 'channel-members':
      return ((await admin.channelMembers(channel)) as Record<string, unknown>[]).map(
        (info) => info.userId,
      );
    case 'channel-kick':
      return (
        (await admin.channelKick(
          channel,
          { __wskit: 'user-ref', id: userId, instance: undefined },
          { reason: 'admin kick' },
        )) ?? null
      );
    default:
      return UNKNOWN_OP;
  }
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

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const room = roomFrom(url);

  try {
    if (url.pathname === '/__health') {
      writeText(response, 200, 'ok');
      return;
    }

    if (url.pathname === '/ws/plugins/shutdown') {
      await shutdownFixture('/ws/plugins', room);
      writeText(response, 204, '');
      return;
    }

    if (url.pathname === '/ws/admin/purge' || url.pathname === '/ws/admin/announce') {
      const fixture = getFixture('/ws/admin', room);
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
      const fixture = getFixture('/ws/admin', room);
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

    if (url.pathname.startsWith('/ws/admin/builtin/')) {
      const fixture = getFixture('/ws/admin', room);
      await fixture.service.ready;
      const result = await runAdminBuiltIn(
        await adminOf(fixture),
        url.pathname.slice('/ws/admin/builtin/'.length),
        {
          text: url.searchParams.get('text') ?? '',
          userId: url.searchParams.get('userId') ?? '',
          channel: url.searchParams.get('channel') ?? 'lobby',
          url,
        },
      );
      if (result === UNKNOWN_OP) {
        writeText(response, 404, `unknown builtin op: ${url.pathname}`);
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
      const fixture = getFixture('/ws/receipts', room);
      await fixture.service.ready;
      const admin = await adminOf(fixture);
      await admin.seedStaleReceipt();
      writeText(response, 204, '');
      return;
    }

    if (url.pathname === '/ws/receipts/stale-count') {
      const fixture = getFixture('/ws/receipts', room);
      await fixture.service.ready;
      const admin = await adminOf(fixture);
      writeJson(response, 200, { count: await admin.staleReceiptCount() });
      return;
    }

    if (url.pathname === '/ws/receipts/drop-inbox') {
      const fixture = getFixture('/ws/receipts', room);
      await fixture.service.ready;
      const admin = await adminOf(fixture);
      await admin.dropInboxTable();
      writeText(response, 204, '');
      return;
    }

    if (url.pathname === '/ws/receipts/receivers') {
      const fixture = getFixture('/ws/receipts', room);
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
      const fixture = getFixture('/ws/receipts', room);
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

    if (FEATURE_ROUTES[url.pathname]) {
      writeText(response, 426, 'Upgrade Required');
      return;
    }

    writeText(response, 404, 'not found');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    writeText(response, 500, message);
  }
}

function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const spec = FEATURE_ROUTES[url.pathname];
  if (!spec) {
    socket.destroy();
    return;
  }

  const fixture = getFixture(url.pathname, roomFrom(url));
  fixture.transport.emit('upgrade', request, socket, head);
}

async function shutdownAll(root: Server): Promise<void> {
  const current = [...fixtures.values()];
  fixtures.clear();
  await Promise.allSettled(current.map((fixture) => fixture.service.shutdown()));
  await new Promise<void>((resolve) => root.close(() => resolve()));
}

const root = createServer((request, response) => {
  void handleRequest(request, response);
});

root.on('upgrade', handleUpgrade);
process.once('SIGINT', () => void shutdownAll(root));
process.once('SIGTERM', () => void shutdownAll(root));
process.once('exit', () => rmSync(stateRoot, { recursive: true, force: true }));

const port = Number(process.env.WSKIT_E2E_SERVER_PORT ?? 8787);
root.listen(port, '127.0.0.1', () => {
  console.log(`WSKit Node e2e server listening on 127.0.0.1:${port}`);
});
