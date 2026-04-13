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
