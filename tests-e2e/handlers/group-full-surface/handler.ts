import { implement } from '@wskit/server';
import type { InferClient } from '@wskit/server';
import { groupFullSurfaceContract } from './contract.ts';
import { fullSurfaceGroup } from './group.ts';

export const groupFullSurfaceHandler = implement(groupFullSurfaceContract)
  .use(fullSurfaceGroup)
  .build();

export type GroupFullSurfaceClient = InferClient<typeof groupFullSurfaceHandler>;
