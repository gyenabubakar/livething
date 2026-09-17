import { emits, server, t } from '@wskit/server';
import { channels } from '@wskit/server/channels';
import { scheduled } from '@wskit/server/scheduled';
import { resumableStream } from '@wskit/server/streams';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { requireUsername } from '../_shared/upgrade.ts';

const base = server({
  upgrade: requireUsername,
  capabilities: [
    channels(),
    scheduled({ 'admin-announce': { data: t<{ text: string }>() } }),
    // Listed but never used: this server declares a durable stream and no test
    // ever starts one. `purgeUser` must still delete stream rows, which means
    // the stream tables have to exist from boot rather than from first use.
    resumableStream(),
    emits({
      announced: t<{ text: string }>(),
      poked: t<{ text: string }>(),
      notified: t<{ text: string }>(),
      'room-notice': t<{ text: string }>(),
    }),
  ],
});

const noop = base.on('noop', { input: v.object({}), run() {} });

export const lobby = base.channel('lobby', {
  membership: 'persistent',
  capabilities: [emits({ 'room-notice': t<{ text: string }>() })],
});

const handleJoinLobby = lobby.on('join-lobby', { input: v.object({}), run() {} });

base.scheduled('admin-announce', {
  run(ctx, data) {
    ctx.broadcast('announced', { text: data.text });
  },
});

/**
 * A server whose whole point is the admin surface. Every member of the admin
 * ctx is reachable through an `api` method here, so the e2e can prove each one
 * works when driven from a Worker over the DO stub — not just `broadcast`.
 *
 * The capability list is what makes the gated members exist: `channels()` for
 * `ctx.channels`, and `scheduled()` for `ctx.schedule` / `ctx.cancelScheduled`.
 * `purgeUser` needs no capability of its own — it wipes whatever durable state
 * the listed capabilities own.
 */
export const adminDefinition = base.assemble({
  handlers: [noop, handleJoinLobby, lobby],
  api: (ctx) => ({
    announce(text: string) {
      ctx.broadcast('announced', { text });
    },

    countNow(): number {
      return ctx.connectionCount;
    },

    whoIsOnline(): string[] {
      return ctx.connections.all().map((info) => info.userId);
    },

    connectionIdsOf(userId: string): string[] {
      return ctx.users
        .get(userId)
        .connections()
        .map((info) => info.id);
    },

    pokeConnection(connectionId: string, text: string): boolean {
      const target = ctx.connections.all().find((info) => info.id === connectionId);
      if (!target) return false;

      return ctx.connections.get(target.ref()).send('poked', { text });
    },

    closeConnection(connectionId: string, code: number, reason: string): boolean {
      const target = ctx.connections.all().find((info) => info.id === connectionId);
      if (!target) return false;

      ctx.connections.get(target.ref()).close(code, reason);
      return true;
    },

    notifyUser(userId: string, text: string): number {
      return ctx.users.get(userId).broadcast('notified', { text });
    },

    bootUser(userId: string): void {
      ctx.users.get(userId).close(4321, 'booted by admin');
    },

    announceIn(channel: string, text: string): void {
      ctx.channels.get(channel).broadcast('room-notice', { text });
    },

    membersOf(channel: string): string[] {
      return ctx.channels
        .get(channel)
        .members()
        .map((info) => info.userId);
    },

    async kickFrom(channel: string, userId: string): Promise<void> {
      await ctx.channels.get(channel).kick(ctx.users.get(userId).ref(), { reason: 'admin kick' });
    },

    scheduleAnnounce(delayMs: number, text: string): void {
      ctx.schedule('admin-announce', { time: Date.now() + delayMs, data: { text } });
    },

    cancelAnnounce(): void {
      ctx.cancelScheduled('admin-announce');
    },

    writeNote(text: string): void {
      ctx.sql.exec('CREATE TABLE IF NOT EXISTS admin_notes (text TEXT)');
      ctx.sql.exec('INSERT INTO admin_notes (text) VALUES (?)', text);
    },

    readNotes(): string[] {
      ctx.sql.exec('CREATE TABLE IF NOT EXISTS admin_notes (text TEXT)');
      return ctx.sql
        .exec<{ text: string }>('SELECT text FROM admin_notes')
        .toArray()
        .map((row) => row.text);
    },

    async putFlag(key: string, value: string): Promise<void> {
      await ctx.kv.set(key, value);
    },

    async getFlag(key: string): Promise<string | null> {
      const value = await ctx.kv.get(key);
      return typeof value === 'string' ? value : null;
    },

    logSomething(text: string): void {
      ctx.log.info('[e2e] admin log', { text });
    },

    hasPlatform(): boolean {
      return ctx.platform !== undefined && ctx.platform !== null;
    },
  }),
});

export type AdminClient = InferClient<typeof adminDefinition>;
