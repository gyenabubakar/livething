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
    incoming('insert-record', InsertRecord),
    incoming('get-all-records', GetAllRecords),
    incoming('get-record', GetRecord),
    incoming('delete-record', DeleteRecord),
    incoming('get-record-count', GetRecordCount),
    incoming('get-message-count', GetMessageCount),
    incoming('trigger-vacuum', TriggerVacuum),
    incoming('get-outgoing-count', GetOutgoingCount),
    incoming('get-disconnect-count', GetDisconnectCount),
    incoming('get-generated-id', GetGeneratedId),
    incoming('get-last-state', GetLastState),
    incoming('get-shutdown-count', GetShutdownCount),
    incoming('module-rewrite-probe', ModuleRewriteProbe),
    incoming('trigger-module-every', TriggerModuleEvery),
    incoming('trigger-module-flaky', TriggerModuleFlaky),
    incoming('trigger-module-always-fail', TriggerModuleAlwaysFail),
    incoming('trigger-module-query-dlq', TriggerModuleQueryDlq),
    incoming('trigger-module-denied', TriggerModuleDenied),
    incoming('trigger-module-error', TriggerModuleError),
    incoming('trigger-module-task-with-data', TriggerModuleTaskWithData),

    outgoing('record-inserted', RecordInserted),
    outgoing('record-list', RecordList),
    outgoing('single-record', SingleRecord),
    outgoing('record-deleted', RecordDeleted),
    outgoing('record-count', RecordCount),
    outgoing('message-count', MessageCount),
    outgoing('drizzle-vacuum-done', VacuumDone),
    outgoing('outgoing-count', OutgoingCount),
    outgoing('disconnect-count', DisconnectCount),
    outgoing('generated-id', GeneratedId),
    outgoing('last-state', LastState),
    outgoing('shutdown-count', ShutdownCount),
    outgoing('module-rewrite-result', ModuleRewriteResult),
    outgoing('module-every-tick', ModuleEveryTick),
    outgoing('module-flaky-result', ModuleFlakyResult),
    outgoing('module-dlq-result', ModuleDlqResult),
    outgoing('error-result', ErrorResult),
    outgoing('module-task-data-result', ModuleTaskDataResult),

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
      {
        time: Date.now() + 200,
      },
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
      {
        time: Date.now() + 100,
      },
    );
  })
  .on('trigger-module-flaky', (ctx) => {
    (ctx.schedule as (id: string, opts: { time: number; data?: unknown }) => void)(
      '__e2e:drizzle:drizzle-flaky',
      {
        time: Date.now() + 100,
      },
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
      {
        time: Date.now() + 100,
      },
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
