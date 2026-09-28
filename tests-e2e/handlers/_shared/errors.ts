import { error } from '@livething/server/errors';
import * as v from 'valibot';

export const NotFound = error('not-found', v.object({ id: v.string() }));
export const Forbidden = error('forbidden', v.object({ reason: v.string() }));
