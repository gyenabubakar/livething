import { define, emits, t } from '@wskit/server';
import { observeHost } from '@wskit/server/plugin';
import { stream } from '@wskit/server/streams';
import { requireUsername } from '@wskit/tests-e2e-handlers/_shared/upgrade';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { Drizzle } from './drizzle-plugin.ts';
import {
  DeleteRecord,
  GetAllRecords,
  GetDisconnectCount,
  GetGeneratedId,
  GetLastState,
  GetMessageCount,
  GetOutgoingCount,
  GetRecord,
  GetRecordCount,
  GetShutdownCount,
  InsertRecord,
  PluginRewriteProbe,
} from './events.ts';
import type {
  DisconnectCount,
  GeneratedId,
  LastState,
  MessageCount,
  OutgoingCount,
  PluginRewriteResult,
  RecordCount,
  RecordDeleted,
  RecordInserted,
  RecordList,
  ShutdownCount,
  SingleRecord,
} from './events.ts';

const StreamConnectionIdPayload = v.object({ count: v.number() });
const StreamConnectionIdChunk = v.object({ id: v.string() });

const StreamThrowOnCancelPayload = v.object({});
const StreamThrowOnCancelChunk = v.object({ tick: v.number() });

const base = define({
  env: t<Env>(),
  upgrade: (request) => requireUsername(request),
  capabilities: [
    stream(),
    observeHost(Drizzle()),
    emits({
      'record-inserted': t<v.InferOutput<typeof RecordInserted>>(),
      'record-list': t<v.InferOutput<typeof RecordList>>(),
      'single-record': t<v.InferOutput<typeof SingleRecord>>(),
      'record-deleted': t<v.InferOutput<typeof RecordDeleted>>(),
      'record-count': t<v.InferOutput<typeof RecordCount>>(),
      'message-count': t<v.InferOutput<typeof MessageCount>>(),
      'outgoing-count': t<v.InferOutput<typeof OutgoingCount>>(),
      'disconnect-count': t<v.InferOutput<typeof DisconnectCount>>(),
      'generated-id': t<v.InferOutput<typeof GeneratedId>>(),
      'last-state': t<v.InferOutput<typeof LastState>>(),
      'shutdown-count': t<v.InferOutput<typeof ShutdownCount>>(),
      'plugin-rewrite-result': t<v.InferOutput<typeof PluginRewriteResult>>(),
    }),
  ],
});

base.connect((ctx) => {
  ctx.log.info('Plugin handler: client connected', { id: ctx.id });
});

const handleInsert = base.on('insert-record', {
  input: InsertRecord,
  run(ctx, payload) {
    const row = ctx.plugin('e2e:drizzle').insert({ name: payload.name, value: payload.value });
    ctx.send('record-inserted', { id: row.id });
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
    ctx.send('single-record', { record: ctx.plugin('e2e:drizzle').findById(payload.id) ?? null });
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

const handleStreamConnectionId = base.stream('stream-connection-id', {
  input: StreamConnectionIdPayload,
  chunk: StreamConnectionIdChunk,
  async *run(ctx, payload) {
    const db = ctx.plugin('e2e:drizzle');
    for (let i = 0; i < payload.count; i++) {
      yield { id: db.getCurrentConnectionId() ?? '' };
      await new Promise((r) => setTimeout(r, 5));
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
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      // oxlint-disable-next-line no-unsafe-finally
      throw new Error('e2e: stream finally threw');
    }
  },
});

export const pluginsHandler = base.assemble(
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
  handleStreamConnectionId,
  handleStreamThrowOnCancel,
);

export type PluginsClient = InferClient<typeof pluginsHandler>;
