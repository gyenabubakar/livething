import { server } from '@wskit/server-cloudflare';
import { replaySnapshotHandler } from './handler.ts';

export const ReplaySnapshotServer = server(replaySnapshotHandler);
