import { emits, server, t } from '@livething/server';
import { dedup } from '@livething/server/dedup';
import { sequence } from '@livething/server/sequence';
import { stream } from '@livething/server/streams';
import { Feed } from '@livething/tests-e2e-handlers/_shared/feed-plugin';
import { Probe } from '@livething/tests-e2e-handlers/_shared/probe-plugin';
import { requireUsername } from '@livething/tests-e2e-handlers/_shared/upgrade';
import * as v from 'valibot';
import type { ServerContract } from '@livething/server/adapters';
import type { PluginCapability } from '@livething/server/plugins';

export interface DrizzlePluginApi {
  insert(data: { name: string; value: string }): { id: number } | null;
  findAll(): unknown[];
  findById(id: number): unknown;
  deleteById(id: number): boolean;
  count(): number;
  getMessageCount(): number;
  getOutgoingCount(): number;
  getDisconnectCount(): number;
  getLastGeneratedId(): string | null;
  getLastState(): unknown;
  getShutdownCount(): number;
  getCurrentConnectionId(): string | null;
}

type DrizzleCapability<
  TContract extends ServerContract,
  TApi extends DrizzlePluginApi,
> = PluginCapability<'e2e:drizzle', TContract, TApi>;

export function createPluginsDefinition<
  TContract extends ServerContract,
  TApi extends DrizzlePluginApi,
>(drizzle: () => DrizzleCapability<TContract, TApi>) {
  const InsertRecord = v.object({ name: v.string(), value: v.string() });
  const GetAllRecords = v.object({});
  const GetRecord = v.object({ id: v.number() });
  const DeleteRecord = v.object({ id: v.number() });
  const GetRecordCount = v.object({});

  const GetMessageCount = v.object({});
  const GetOutgoingCount = v.object({});
  const GetDisconnectCount = v.object({});
  const GetGeneratedId = v.object({});
  const GetLastState = v.object({});

  const GetShutdownCount = v.object({});
  const PluginRewriteProbe = v.object({ text: v.string(), rewritten: v.optional(v.boolean()) });

  const StreamConnectionIdPayload = v.object({ count: v.number() });
  const StreamThrowOnCancelPayload = v.object({});
  const StreamConnectionIdChunk = t<{ id: string }>();
  const StreamThrowOnCancelChunk = t<{ tick: number }>();

  const drizzleCapability = drizzle();

  const base = server({
    upgrade: (request) => requireUsername(request),
    capabilities: [
      stream(),
      sequence({ persist: true }),
      dedup(),
      Feed(),
      Probe(),
      drizzleCapability,
      emits({
        'record-inserted': t<{ id: number }>(),
        'record-list': t<{ records: unknown[] }>(),
        'single-record': t<{ record: unknown }>(),
        'record-deleted': t<{ success: boolean }>(),
        'record-count': t<{ count: number }>(),
        'message-count': t<{ count: number }>(),
        'outgoing-count': t<{ count: number }>(),
        'disconnect-count': t<{ count: number }>(),
        'generated-id': t<{ value: string | null }>(),
        'last-state': t<{ state: unknown }>(),
        'shutdown-count': t<{ count: number }>(),
        'plugin-rewrite-result': t<{ text: string; rewritten?: boolean }>(),
      }),
    ],
  });

  base.onConnect((ctx) => {
    ctx.log.info('Plugin server: client connected', { id: ctx.connection.id });
  });

  const handleInsert = base.on('insert-record', {
    input: InsertRecord,
    run(ctx, payload) {
      const row = ctx.plugin('e2e:drizzle').insert(payload);
      ctx.send('record-inserted', { id: row?.id ?? 0 });
    },
  });

  const handleGetAll = base.on('get-all-records', {
    input: GetAllRecords,
    run(ctx) {
      ctx.send('record-list', { records: ctx.plugin('e2e:drizzle').findAll() });
    },
  });

  const handleGetRecord = base.on('get-record', {
    input: GetRecord,
    run(ctx, payload) {
      ctx.send('single-record', {
        record: ctx.plugin('e2e:drizzle').findById(payload.id) ?? null,
      });
    },
  });

  const handleDelete = base.on('delete-record', {
    input: DeleteRecord,
    run(ctx, payload) {
      ctx.send('record-deleted', { success: ctx.plugin('e2e:drizzle').deleteById(payload.id) });
    },
  });

  const handleCount = base.on('get-record-count', {
    input: GetRecordCount,
    run(ctx) {
      ctx.send('record-count', { count: ctx.plugin('e2e:drizzle').count() });
    },
  });

  const handleMessageCount = base.on('get-message-count', {
    input: GetMessageCount,
    run(ctx) {
      ctx.send('message-count', { count: ctx.plugin('e2e:drizzle').getMessageCount() });
    },
  });

  const handleOutgoingCount = base.on('get-outgoing-count', {
    input: GetOutgoingCount,
    run(ctx) {
      ctx.send('outgoing-count', { count: ctx.plugin('e2e:drizzle').getOutgoingCount() });
    },
  });

  const handleDisconnectCount = base.on('get-disconnect-count', {
    input: GetDisconnectCount,
    run(ctx) {
      ctx.send('disconnect-count', { count: ctx.plugin('e2e:drizzle').getDisconnectCount() });
    },
  });

  const handleGeneratedId = base.on('get-generated-id', {
    input: GetGeneratedId,
    run(ctx) {
      ctx.send('generated-id', { value: ctx.plugin('e2e:drizzle').getLastGeneratedId() });
    },
  });

  const handleLastState = base.on('get-last-state', {
    input: GetLastState,
    run(ctx) {
      ctx.send('last-state', { state: ctx.plugin('e2e:drizzle').getLastState() });
    },
  });

  const handleShutdownCount = base.on('get-shutdown-count', {
    input: GetShutdownCount,
    run(ctx) {
      ctx.send('shutdown-count', { count: ctx.plugin('e2e:drizzle').getShutdownCount() });
    },
  });

  const handleRewriteProbe = base.on('plugin-rewrite-probe', {
    input: PluginRewriteProbe,
    run(ctx, payload) {
      const observed = payload as { text: string; rewritten?: boolean };
      ctx.send('plugin-rewrite-result', { text: observed.text, rewritten: observed.rewritten });
    },
  });

  const handleAppFail = base.on('app-fail', {
    input: v.object({}),
    run() {
      throw new Error('e2e: app handler failed');
    },
  });

  const handleStreamConnectionId = base.stream('stream-connection-id', {
    input: StreamConnectionIdPayload,
    chunk: StreamConnectionIdChunk,
    async *run(ctx, payload) {
      const db = ctx.plugin('e2e:drizzle');
      for (let i = 0; i < payload.count; i++) {
        yield { id: db.getCurrentConnectionId() ?? '' };
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  });

  const handleStreamThrowOnCancel = base.stream('stream-throw-on-cancel', {
    input: StreamThrowOnCancelPayload,
    chunk: StreamThrowOnCancelChunk,
    async *run() {
      try {
        let i = 0;
        while (true) {
          yield { tick: i++ };
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } finally {
        // oxlint-disable-next-line no-unsafe-finally
        throw new Error('e2e: stream finally threw');
      }
    },
  });

  return base.assemble({
    handlers: [
      handleInsert,
      handleGetAll,
      handleGetRecord,
      handleDelete,
      handleCount,
      handleMessageCount,
      handleOutgoingCount,
      handleDisconnectCount,
      handleGeneratedId,
      handleLastState,
      handleShutdownCount,
      handleRewriteProbe,
      handleAppFail,
      handleStreamConnectionId,
      handleStreamThrowOnCancel,
    ],
  });
}
