import { server } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withScheduled } from '@wskit/server/scheduled';
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

export const modulesHandler = withScheduled(withLifecycle(server<Env>('modules-test')))
  .outgoing(RecordInserted)
  .outgoing(RecordList)
  .outgoing(SingleRecord)
  .outgoing(RecordDeleted)
  .outgoing(RecordCount)
  .outgoing(MessageCount)
  .outgoing(VacuumDone)
  .outgoing(OutgoingCount)
  .outgoing(DisconnectCount)
  .outgoing(GeneratedId)
  .outgoing(LastState)
  .outgoing(ShutdownCount)
  .outgoing(ModuleRewriteResult)
  .outgoing(ModuleEveryTick)
  .outgoing(ModuleFlakyResult)
  .outgoing(ModuleDlqResult)
  .outgoing(ErrorResult)
  .outgoing(ModuleTaskDataResult)
  .use(Drizzle({ migrate: true }))
  .onUpgrade((request) => {
    const url = new URL(request.url);
    const username = url.searchParams.get('username');
    if (!username) throw RejectUpgrade(4001, 'Missing username');
    return { meta: { username } };
  })
  .onConnect((ctx) => {
    ctx.log.info('Module handler: client connected', { id: ctx.id });
  })
  .incoming(InsertRecord, (ctx, payload) => {
    const db = Drizzle.use(ctx);
    const row = db.insert({ name: payload.name, value: payload.value });
    ctx.send('record-inserted', { id: row.id });
  })
  .incoming(GetAllRecords, (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('record-list', { records: db.findAll() });
  })
  .incoming(GetRecord, (ctx, payload) => {
    const db = Drizzle.use(ctx);
    ctx.send('single-record', { record: db.findById(payload.id) ?? null });
  })
  .incoming(DeleteRecord, (ctx, payload) => {
    const db = Drizzle.use(ctx);
    ctx.send('record-deleted', { success: db.deleteById(payload.id) });
  })
  .incoming(GetRecordCount, (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('record-count', { count: db.count() });
  })
  .incoming(GetMessageCount, (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('message-count', { count: db.getMessageCount() });
  })
  .incoming(TriggerVacuum, (ctx) => {
    ctx.schedule('__e2e:drizzle:drizzle-vacuum', { time: Date.now() + 200 });
  })
  .incoming(GetOutgoingCount, (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('outgoing-count', { count: db.getOutgoingCount() });
  })
  .incoming(GetDisconnectCount, (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('disconnect-count', { count: db.getDisconnectCount() });
  })
  .incoming(GetGeneratedId, (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('generated-id', { value: db.getLastGeneratedId() });
  })
  .incoming(GetLastState, (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('last-state', { state: db.getLastState() });
  })
  .incoming(GetShutdownCount, (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('shutdown-count', { count: db.getShutdownCount() });
  })
  .incoming(ModuleRewriteProbe, (ctx, payload) => {
    // payload is whatever the module's onIncoming returned — the handler
    // echoes it so Playwright can confirm the rewrite fired.
    const observed = payload as unknown as { text: string; rewritten?: boolean };
    ctx.send('module-rewrite-result', {
      text: observed.text,
      rewritten: observed.rewritten,
    });
  })
  .incoming(TriggerModuleEvery, (ctx) => {
    ctx.schedule('__e2e:drizzle:drizzle-every-tick', { time: Date.now() + 100 });
  })
  .incoming(TriggerModuleFlaky, (ctx) => {
    ctx.schedule('__e2e:drizzle:drizzle-flaky', { time: Date.now() + 100 });
  })
  .incoming(TriggerModuleAlwaysFail, (ctx) => {
    ctx.schedule('__e2e:drizzle:drizzle-module-always-fail', { time: Date.now() + 100 });
  })
  .incoming(TriggerModuleQueryDlq, (ctx) => {
    ctx.schedule('__e2e:drizzle:drizzle-query-dlq', { time: Date.now() + 100 });
  })
  .incoming(TriggerModuleDenied, () => {
    throw DrizzleDenied({ reason: 'test denial', op: 'insert' });
  })
  .incoming(TriggerModuleError, (ctx) => {
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
  .incoming(TriggerModuleTaskWithData, (ctx) => {
    ctx.schedule('__e2e:drizzle:drizzle-task-with-data', {
      time: Date.now() + 100,
      data: { value: 'test-data' },
    });
  })
  .build();

export type ModulesClient = InferClient<typeof modulesHandler>;
