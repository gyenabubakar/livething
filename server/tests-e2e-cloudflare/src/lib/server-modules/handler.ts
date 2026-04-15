import { server } from '@wskit/server';
import { RejectUpgrade } from '@wskit/server/errors';
import { withLifecycle } from '@wskit/server/lifecycle';
import { withScheduled } from '@wskit/server/scheduled';
import type { InferClient } from '@wskit/server';
import { Drizzle } from './drizzle-module.ts';
import {
  DeleteRecord,
  GetAllRecords,
  GetMessageCount,
  GetOutgoingCount,
  GetRecord,
  GetRecordCount,
  InsertRecord,
  MessageCount,
  OutgoingCount,
  RecordCount,
  RecordDeleted,
  RecordInserted,
  RecordList,
  SingleRecord,
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
    ctx.schedule('drizzle-vacuum', { time: Date.now() + 200 });
  })
  .incoming(GetOutgoingCount, (ctx) => {
    const db = Drizzle.use(ctx);
    ctx.send('outgoing-count', { count: db.getOutgoingCount() });
  })
  .build();

export type ModulesClient = InferClient<typeof modulesHandler>;
