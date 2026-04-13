import { event } from '@wskit/server';
import * as v from 'valibot';

export const Note = event('note', v.object({ text: v.string(), author: v.string() }));
export const AddNote = event('add-note', v.object({ text: v.string() }));
export const GetConfirmedCount = event('get-confirmed-count', v.object({}));
export const ConfirmedCount = event(
  'confirmed-count',
  v.object({ total: v.number(), confirmed: v.number() }),
);
