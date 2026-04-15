import { event } from '@wskit/server';
import * as v from 'valibot';

export const UpdateDoc = event('update-doc', v.object({ docId: v.string(), title: v.string() }));
export const DocSnapshot = event(
  'doc-snapshot',
  v.object({ docId: v.string(), title: v.string() }),
);

export const IncrementCounter = event(
  'increment-counter',
  v.object({ key: v.string(), amount: v.number() }),
);
export const CounterSnapshot = event(
  'counter-snapshot',
  v.object({ key: v.string(), total: v.number() }),
);
