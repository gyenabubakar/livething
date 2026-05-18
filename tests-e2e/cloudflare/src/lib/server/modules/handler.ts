import { contract, implement, incoming, outgoing, stream, t } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import * as v from 'valibot';
import type { InferClient } from '@wskit/server';
import { Drizzle, DrizzleDenied } from './drizzle-module.ts';
import {
  DeleteRecord,
  DisconnectCount,
  ErrorResult,
  GeneratedId,
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
  LastState,
  MessageCount,
  ModuleDlqResult,
  ModuleEveryTick,
  ModuleFlakyResult,
  ModuleRewriteProbe,
  ModuleRewriteResult,
  ModuleTaskDataResult,
  OutgoingCount,
  RecordCount,
  RecordDeleted,
  RecordInserted,
  RecordList,
  ShutdownCount,
  SingleRecord,
  TriggerModuleAlwaysFail,
  TriggerModuleDenied,
  TriggerModuleError,
  TriggerModuleEvery,
  TriggerModuleFlaky,
  TriggerModuleQueryDlq,
  TriggerModuleTaskWithData,
  TriggerVacuum,
  VacuumDone,
} from './events.ts';

const StreamConnectionIdPayload = v.object({ count: v.number() });
const StreamConnectionIdChunk = v.object({ id: v.string() });

const StreamThrowOnCancelPayload = v.object({});
const StreamThrowOnCancelChunk = v.object({ tick: v.number() });

export const modulesContract = contract<Env>('modules-test')({
  meta: t<{ username: string }>(),
  modules: [Drizzle({ migrate: true })],
  definitions: [
    incoming(InsertRecord.event, InsertRecord.schema),
    incoming(GetAllRecords.event, GetAllRecords.schema),
    incoming(GetRecord.event, GetRecord.schema),
    incoming(DeleteRecord.event, DeleteRecord.schema),
    incoming(GetRecordCount.event, GetRecordCount.schema),
    incoming(GetMessageCount.event, GetMessageCount.schema),
    incoming(TriggerVacuum.event, TriggerVacuum.schema),
    incoming(GetOutgoingCount.event, GetOutgoingCount.schema),
    incoming(GetDisconnectCount.event, GetDisconnectCount.schema),
    incoming(GetGeneratedId.event, GetGeneratedId.schema),
    incoming(GetLastState.event, GetLastState.schema),
    incoming(GetShutdownCount.event, GetShutdownCount.schema),
    incoming(ModuleRewriteProbe.event, ModuleRewriteProbe.schema),
    incoming(TriggerModuleEvery.event, TriggerModuleEvery.schema),
    incoming(TriggerModuleFlaky.event, TriggerModuleFlaky.schema),
    incoming(TriggerModuleAlwaysFail.event, TriggerModuleAlwaysFail.schema),
    incoming(TriggerModuleQueryDlq.event, TriggerModuleQueryDlq.schema),
    incoming(TriggerModuleDenied.event, TriggerModuleDenied.schema),
    incoming(TriggerModuleError.event, TriggerModuleError.schema),
    incoming(TriggerModuleTaskWithData.event, TriggerModuleTaskWithData.schema),

    outgoing(RecordInserted.event, RecordInserted.schema),
    outgoing(RecordList.event, RecordList.schema),
    outgoing(SingleRecord.event, SingleRecord.schema),
    outgoing(RecordDeleted.event, RecordDeleted.schema),
    outgoing(RecordCount.event, RecordCount.schema),
    outgoing(MessageCount.event, MessageCount.schema),
    outgoing(VacuumDone.event, VacuumDone.schema),
    outgoing(OutgoingCount.event, OutgoingCount.schema),
    outgoing(DisconnectCount.event, DisconnectCount.schema),
    outgoing(GeneratedId.event, GeneratedId.schema),
    outgoing(LastState.event, LastState.schema),
    outgoing(ShutdownCount.event, ShutdownCount.schema),
    outgoing(ModuleRewriteResult.event, ModuleRewriteResult.schema),
    outgoing(ModuleEveryTick.event, ModuleEveryTick.schema),
    outgoing(ModuleFlakyResult.event, ModuleFlakyResult.schema),
    outgoing(ModuleDlqResult.event, ModuleDlqResult.schema),
    outgoing(ErrorResult.event, ErrorResult.schema),
    outgoing(ModuleTaskDataResult.event, ModuleTaskDataResult.schema),

    stream('stream-connection-id', {
      payload: StreamConnectionIdPayload,
      chunk: StreamConnectionIdChunk,
    }),
    stream('stream-throw-on-cancel', {
      payload: StreamThrowOnCancelPayload,
      chunk: StreamThrowOnCancelChunk,
    }),
  ],
});

export const modulesHandler = implement(modulesContract)
  .onUpgrade((request) => {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    if (!username) throw RejectUpgrade(4001, 'Missing username');
    return { identity: username, meta: { username } };
  })
  .onConnect((ctx) => {
    ctx.log.info('Module handler: client connected', { id: ctx.id });
  })
  .on('insert-record', (ctx, payload) => {
    const db = Drizzle.use(ctx);
    const row = db.insert({ name: payload.name, value: payload.value });
    ctx.send('record-inserted', { id: row.id });
  })
  .on('get-all-records', (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('record-list', { records: db.findAll() });
  })
  .on('get-record', (ctx, payload) => {
    const db = Drizzle.use(ctx);
    ctx.send('single-record', { record: db.findById(payload.id) ?? null });
  })
  .on('delete-record', (ctx, payload) => {
    const db = Drizzle.use(ctx);
    ctx.send('record-deleted', { success: db.deleteById(payload.id) });
  })
  .on('get-record-count', (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('record-count', { count: db.count() });
  })
  .on('get-message-count', (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('message-count', { count: db.getMessageCount() });
  })
  .on('trigger-vacuum', (ctx) => {
    (ctx.schedule as (id: string, opts: { time: number; data?: unknown }) => void)(
      '__e2e:drizzle:drizzle-vacuum',
      { time: Date.now() + 200 },
    );
  })
  .on('get-outgoing-count', (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('outgoing-count', { count: db.getOutgoingCount() });
  })
  .on('get-disconnect-count', (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('disconnect-count', { count: db.getDisconnectCount() });
  })
  .on('get-generated-id', (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('generated-id', { value: db.getLastGeneratedId() });
  })
  .on('get-last-state', (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('last-state', { state: db.getLastState() });
  })
  .on('get-shutdown-count', (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('shutdown-count', { count: db.getShutdownCount() });
  })
  .on('module-rewrite-probe', (ctx, payload) => {
    const observed = payload as unknown as { text: string; rewritten?: boolean };
    ctx.send('module-rewrite-result', {
      text: observed.text,
      rewritten: observed.rewritten,
    });
  })
  .on('trigger-module-every', (ctx) => {
    (ctx.schedule as (id: string, opts: { time: number; data?: unknown }) => void)(
      '__e2e:drizzle:drizzle-every-tick',
      { time: Date.now() + 100 },
    );
  })
  .on('trigger-module-flaky', (ctx) => {
    (ctx.schedule as (id: string, opts: { time: number; data?: unknown }) => void)(
      '__e2e:drizzle:drizzle-flaky',
      { time: Date.now() + 100 },
    );
  })
  .on('trigger-module-always-fail', (ctx) => {
    (ctx.schedule as (id: string, opts: { time: number; data?: unknown }) => void)(
      '__e2e:drizzle:drizzle-module-always-fail',
      { time: Date.now() + 100 },
    );
  })
  .on('trigger-module-query-dlq', (ctx) => {
    (ctx.schedule as (id: string, opts: { time: number; data?: unknown }) => void)(
      '__e2e:drizzle:drizzle-query-dlq',
      { time: Date.now() + 100 },
    );
  })
  .on('trigger-module-denied', () => {
    throw DrizzleDenied({ reason: 'test denial', op: 'insert' });
  })
  .on('trigger-module-error', (ctx) => {
    try {
      throw DrizzleDenied({ reason: 'test denial', op: 'insert' });
    } catch (err: unknown) {
      const error = err as { code: string; detail?: { reason: string } };
      const reason = error.detail?.reason ?? 'unknown';
      ctx.send('error-result', {
        code: error.code,
        message: reason,
      });
    }
  })
  .on('trigger-module-task-with-data', (ctx) => {
    (ctx.schedule as (id: string, opts: { time: number; data?: unknown }) => void)(
      '__e2e:drizzle:drizzle-task-with-data',
      {
        time: Date.now() + 100,
        data: { value: 'test-data' },
      },
    );
  })
  .stream('stream-connection-id', async function* (ctx, payload) {
    const db = Drizzle.use(ctx);
    for (let i = 0; i < payload.count; i++) {
      yield { id: db.getCurrentConnectionId() ?? '' };
      await new Promise((r) => setTimeout(r, 5));
    }
  })
  .stream('stream-throw-on-cancel', async function* () {
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
  })
  .build();

export type ModulesClient = InferClient<typeof modulesHandler>;
