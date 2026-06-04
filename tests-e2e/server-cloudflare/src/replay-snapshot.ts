import { server } from '@wskit/server-cloudflare';
import { replaySnapshotHandler } from '@wskit/tests-e2e-handlers/replay-snapshot';

export const ReplaySnapshotServer = server(replaySnapshotHandler);
