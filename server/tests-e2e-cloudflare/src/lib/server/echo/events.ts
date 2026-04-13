import { event } from '@wskit/server';
import * as v from 'valibot';

export const Echo = event('echo', v.object({ text: v.string() }));

export const Echoed = event(
  'echoed',
  v.object({ text: v.string(), from: v.string(), ts: v.number() }),
);

export const TriggerError = event(
  'trigger-error',
  v.object({ code: v.picklist(['not-found', 'forbidden']) }),
);

export const UserJoined = event('user-joined', v.object({ username: v.string() }));
export const UserLeft = event('user-left', v.object({ username: v.string() }));

export const GetTime = event('get-time', v.object({}));
export const TimeResponseSchema = v.object({ iso: v.string(), epoch: v.number() });
