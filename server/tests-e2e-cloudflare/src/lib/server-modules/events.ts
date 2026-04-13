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
