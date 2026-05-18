import * as v from 'valibot';

export const InsertRecord = v.object({ name: v.string(), value: v.string() });
export const GetAllRecords = v.object({});
export const GetRecord = v.object({ id: v.number() });
export const DeleteRecord = v.object({ id: v.number() });
export const GetRecordCount = v.object({});

export const RecordInserted = v.object({ id: v.number() });
export const RecordList = v.object({ records: v.array(v.unknown()) });
export const SingleRecord = v.object({ record: v.unknown() });
export const RecordDeleted = v.object({ success: v.boolean() });
export const RecordCount = v.object({ count: v.number() });

export const GetMessageCount = v.object({});
export const MessageCount = v.object({ count: v.number() });

export const TriggerVacuum = v.object({});
export const VacuumDone = v.object({ timestamp: v.number() });
export const GetOutgoingCount = v.object({});
export const OutgoingCount = v.object({ count: v.number() });

export const GetDisconnectCount = v.object({});
export const DisconnectCount = v.object({ count: v.number() });

export const GetGeneratedId = v.object({});
export const GeneratedId = v.object({ value: v.nullable(v.string()) });

export const GetLastState = v.object({});
export const LastState = v.object({
  state: v.nullable(
    v.object({
      id: v.string(),
      username: v.nullable(v.string()),
      tags: v.array(v.object({ group: v.string(), key: v.string() })),
    }),
  ),
});

export const GetShutdownCount = v.object({});
export const ShutdownCount = v.object({ count: v.number() });

export const ModuleRewriteProbe = v.object({
  text: v.string(),
  rewritten: v.optional(v.boolean()),
});
export const ModuleRewriteResult = v.object({
  text: v.string(),
  rewritten: v.optional(v.boolean()),
});

export const TriggerModuleEvery = v.object({});
export const ModuleEveryTick = v.object({ count: v.number() });
export const TriggerModuleFlaky = v.object({});
export const ModuleFlakyResult = v.object({ attempts: v.number() });
export const TriggerModuleAlwaysFail = v.object({});
export const TriggerModuleQueryDlq = v.object({});
export const ModuleDlqResult = v.object({
  taskId: v.string(),
  attempts: v.number(),
  error: v.string(),
});

export const TriggerModuleDenied = v.object({});

export const TriggerModuleError = v.object({});
export const ErrorResult = v.object({ code: v.string(), message: v.string() });

export const TriggerModuleTaskWithData = v.object({});
export const ModuleTaskDataResult = v.object({ result: v.string() });
