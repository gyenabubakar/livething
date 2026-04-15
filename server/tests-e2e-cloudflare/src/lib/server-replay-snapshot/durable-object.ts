import { serve } from '@wskit/server-cloudflare';
import { replaySnapshotHandler } from './handler.ts';

export const ReplaySnapshotServer = serve(replaySnapshotHandler);
