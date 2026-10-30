// The error definitions from the Error Model page's shared/errors.ts.
import { error } from '@livething/core';
import * as v from 'valibot';

export const NotFound = error('not-found', v.object({ id: v.string() }));

export const NotSignedIn = error('not-signed-in');

export const Forbidden = error('forbidden', v.object({ reason: v.string() }));

export const RoomFull = error('room-full', v.object({ limit: v.number() }));
