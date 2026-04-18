import { event } from '@wskit/server';
import * as v from 'valibot';

export const InsertRecord = event(
  'insert-record',
  v.object({ name: v.string(), value: v.string() }),
);
export const GetAllRecords = event('get-all-records', v.object({}));
export const GetRecord = event('get-record', v.object({ id: v.number() }));
export const DeleteRecord = event('delete-record', v.object({ id: v.number() }));
export const GetRecordCount = event('get-record-count', v.object({}));

export const RecordInserted = event('record-inserted', v.object({ id: v.number() }));
export const RecordList = event('record-list', v.object({ records: v.array(v.unknown()) }));
export const SingleRecord = event('single-record', v.object({ record: v.unknown() }));
export const RecordDeleted = event('record-deleted', v.object({ success: v.boolean() }));
export const RecordCount = event('record-count', v.object({ count: v.number() }));

export const GetMessageCount = event('get-message-count', v.object({}));
export const MessageCount = event('message-count', v.object({ count: v.number() }));

export const TriggerVacuum = event('trigger-vacuum', v.object({}));
export const VacuumDone = event('drizzle-vacuum-done', v.object({ timestamp: v.number() }));
export const GetOutgoingCount = event('get-outgoing-count', v.object({}));
export const OutgoingCount = event('outgoing-count', v.object({ count: v.number() }));

export const GetDisconnectCount = event('get-disconnect-count', v.object({}));
export const DisconnectCount = event('disconnect-count', v.object({ count: v.number() }));

export const GetGeneratedId = event('get-generated-id', v.object({}));
export const GeneratedId = event('generated-id', v.object({ value: v.nullable(v.string()) }));

export const GetLastState = event('get-last-state', v.object({}));
export const LastState = event(
  'last-state',
  v.object({
    state: v.nullable(
      v.object({
        id: v.string(),
        username: v.nullable(v.string()),
        tags: v.array(v.string()),
      }),
    ),
  }),
);

export const GetShutdownCount = event('get-shutdown-count', v.object({}));
export const ShutdownCount = event('shutdown-count', v.object({ count: v.number() }));

export const DrizzleReady = event(
  '__e2e:drizzle:drizzle-ready',
  v.object({ tables: v.array(v.string()), hooked: v.optional(v.boolean()) }),
);

// Module onIncoming rewrite probe — client sends the "raw" event; the module
// rewrites the payload before the handler sees it. The handler then echoes
// whatever payload it observed so Playwright can assert the rewrite happened.
export const ModuleRewriteProbe = event(
  'module-rewrite-probe',
  v.object({ text: v.string(), rewritten: v.optional(v.boolean()) }),
);
export const ModuleRewriteResult = event(
  'module-rewrite-result',
  v.object({ text: v.string(), rewritten: v.optional(v.boolean()) }),
);

// Module scheduled task coverage (every / retry / DLQ)
export const TriggerModuleEvery = event('trigger-module-every', v.object({}));
export const ModuleEveryTick = event('module-every-tick', v.object({ count: v.number() }));
export const TriggerModuleFlaky = event('trigger-module-flaky', v.object({}));
export const ModuleFlakyResult = event('module-flaky-result', v.object({ attempts: v.number() }));
export const TriggerModuleAlwaysFail = event('trigger-module-always-fail', v.object({}));
export const TriggerModuleQueryDlq = event('trigger-module-query-dlq', v.object({}));
export const ModuleDlqResult = event(
  'module-dlq-result',
  v.object({ taskId: v.string(), attempts: v.number(), error: v.string() }),
);

export const TriggerModuleDenied = event('trigger-module-denied', v.object({}));
