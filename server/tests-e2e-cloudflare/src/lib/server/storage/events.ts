import { event } from '@wskit/server';
import * as v from 'valibot';

export const SaveNote = event('save-note', v.object({ title: v.string(), body: v.string() }));
export const GetNotes = event('get-notes', v.object({}));
export const NotesList = event(
  'notes-list',
  v.object({ notes: v.array(v.object({ id: v.number(), title: v.string(), body: v.string() })) }),
);

export const KvSet = event('kv-set', v.object({ key: v.string(), value: v.string() }));
export const KvGet = event('kv-get', v.object({ key: v.string() }));
export const KvResult = event('kv-result', v.object({ key: v.string(), value: v.unknown() }));

export const KvSetTtl = event(
  'kv-set-ttl',
  v.object({ key: v.string(), value: v.string(), ttlMs: v.number() }),
);
export const KvDelete = event('kv-delete', v.object({ key: v.string() }));

export const SqlOneProbe = event('sql-one-probe', v.object({}));
export const SqlOneResult = event(
  'sql-one-result',
  v.object({ row: v.union([v.object({ c: v.number() }), v.null()]) }),
);
export const SqlRawProbe = event('sql-raw-probe', v.object({}));
export const SqlRawResult = event(
  'sql-raw-result',
  v.object({ rows: v.array(v.array(v.unknown())) }),
);
